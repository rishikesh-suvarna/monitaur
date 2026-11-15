package metrics

import (
	"math"
	"time"
)

const (
	secondsPerMinute = 60
	minutesPerHour   = 60
	nanosPerMinute   = int64(time.Minute)

	// noMinute marks "nothing closed yet" for lastClosed* trackers.
	noMinute mins = math.MinInt32
)

// mins is a bucket start in whole minutes since the Unix epoch. int32 covers
// past the year 6000 and keeps the rollup structs small enough to hit the
// per-server memory budget (PLAN.md 2.3.2).
type mins int32

func minuteOf(t time.Time) mins {
	return mins(floorDiv(t.Unix(), secondsPerMinute))
}

func minuteOfNanos(n int64) mins {
	return mins(floorDiv(n, nanosPerMinute))
}

func (m mins) time() time.Time {
	return time.Unix(int64(m)*secondsPerMinute, 0).UTC()
}

func (m mins) nanos() int64 {
	return int64(m) * nanosPerMinute
}

func (m mins) hour() mins {
	return mins(floorDiv(int64(m), minutesPerHour) * minutesPerHour)
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// rawPoint is one accepted sample in the raw ring (32 bytes with padding).
type rawPoint struct {
	t                       int64 // unix nanoseconds, UTC
	cpu, mem, disk, in, out float32
}

// xpoint is the extended (F6) part of a raw point, 20 bytes. It lives in a
// ring beside the raw ring (see extRing) so servers on older agents do not
// pay for it.
type xpoint struct {
	load1, swap, read, write float32
	ok                       bool // the sample carried extended values
}

func (p rawPoint) point(x xpoint) Point {
	return Point{
		Time:         time.Unix(0, p.t).UTC(),
		CPU:          p.cpu,
		Mem:          p.mem,
		Disk:         p.disk,
		NetInBps:     p.in,
		NetOutBps:    p.out,
		Extended:     x.ok,
		Load1:        x.load1,
		Swap:         x.swap,
		DiskReadBps:  x.read,
		DiskWriteBps: x.write,
	}
}

// cbucket is the in-memory form of a closed rollup (72 bytes). Uptime is
// stored as uint32 seconds (136 years) to keep the struct inside 72 bytes.
type cbucket struct {
	memTotal, diskTotal, diskUsed uint64
	start                         mins
	uptime                        uint32
	samples                       uint32
	cpuAvg, cpuMax                float32
	memAvg, memMax                float32
	diskAvg                       float32
	inAvg, inMax                  float32
	outAvg, outMax                float32
}

// xbucket is the extended (F6) part of a closed rollup, 32 bytes. Like
// xpoint it sits in a ring of its own beside the bucket rings.
type xbucket struct {
	n                  uint32 // samples that carried extended values
	load1Avg, load1Max float32
	swapAvg            float32
	readAvg, readMax   float32
	writeAvg, writeMax float32
}

// fbucket is a whole rollup, base and extended part, as it moves between the
// aggregates, the rings, History and the Sink.
type fbucket struct {
	cbucket
	x xbucket
}

func (b fbucket) toBucket(serverID int64, res Resolution) Bucket {
	return Bucket{
		ServerID:       serverID,
		Res:            res,
		Start:          b.start.time(),
		Samples:        int(b.samples),
		CPUAvg:         b.cpuAvg,
		CPUMax:         b.cpuMax,
		MemAvg:         b.memAvg,
		MemMax:         b.memMax,
		DiskAvg:        b.diskAvg,
		NetInAvg:       b.inAvg,
		NetInMax:       b.inMax,
		NetOutAvg:      b.outAvg,
		NetOutMax:      b.outMax,
		MemTotalBytes:  b.memTotal,
		DiskTotalBytes: b.diskTotal,
		DiskUsedBytes:  b.diskUsed,
		UptimeSeconds:  int64(b.uptime),
		ExtSamples:     int(b.x.n),
		Load1Avg:       b.x.load1Avg,
		Load1Max:       b.x.load1Max,
		SwapAvg:        b.x.swapAvg,
		DiskReadAvg:    b.x.readAvg,
		DiskReadMax:    b.x.readMax,
		DiskWriteAvg:   b.x.writeAvg,
		DiskWriteMax:   b.x.writeMax,
	}
}

func compactBucket(b Bucket) fbucket {
	out := fbucket{cbucket: cbucket{
		memTotal:  b.MemTotalBytes,
		diskTotal: b.DiskTotalBytes,
		diskUsed:  b.DiskUsedBytes,
		start:     minuteOf(b.Start),
		uptime:    clampUint32(b.UptimeSeconds),
		samples:   clampUint32(int64(b.Samples)),
		cpuAvg:    b.CPUAvg,
		cpuMax:    b.CPUMax,
		memAvg:    b.MemAvg,
		memMax:    b.MemMax,
		diskAvg:   b.DiskAvg,
		inAvg:     b.NetInAvg,
		inMax:     b.NetInMax,
		outAvg:    b.NetOutAvg,
		outMax:    b.NetOutMax,
	}}
	if n := clampUint32(int64(b.ExtSamples)); n > 0 {
		out.x = xbucket{
			n:        n,
			load1Avg: b.Load1Avg,
			load1Max: b.Load1Max,
			swapAvg:  b.SwapAvg,
			readAvg:  b.DiskReadAvg,
			readMax:  b.DiskReadMax,
			writeAvg: b.DiskWriteAvg,
			writeMax: b.DiskWriteMax,
		}
	}
	return out
}

// fuller picks between two versions of the same bucket (memory vs History).
// They only collide around a restart, where each side holds a disjoint part
// of the period, so the side with more samples is the better partial and we
// never double count. Ties go to a (memory). The extended part travels with
// its base part, so a result never mixes the two versions.
func fuller(a, b fbucket) fbucket {
	if b.samples > a.samples {
		return b
	}
	return a
}

// extRing is a ring of base values plus a ring of extended (F6) values for
// the same elements. The extended ring stays unallocated until the server
// first reports extended values, so servers on older agents keep the base
// memory footprint. From then on both rings are pushed in lockstep, so the
// extended ring always holds the newest ext.size() elements of the base ring.
type extRing[B, X any] struct {
	base ring[B]
	ext  ring[X]
	on   bool
}

func newExtRing[B, X any](limit int) extRing[B, X] {
	return extRing[B, X]{base: newRing[B](limit), ext: newRing[X](limit)}
}

// push appends b (and x once the extended ring is on) and reports the base
// element it evicted, if any. hasExt switches the extended ring on for good.
func (r *extRing[B, X]) push(b B, x X, hasExt bool) (evicted B, ok bool) {
	r.on = r.on || hasExt
	if r.on {
		r.ext.push(x)
	}
	return r.base.push(b)
}

func (r *extRing[B, X]) size() int { return r.base.size() }

// at returns the i-th element, 0 being the oldest. x is the zero value for
// elements pushed before the extended ring was switched on.
func (r *extRing[B, X]) at(i int) (b B, x X) {
	b = r.base.at(i)
	if j := i - (r.base.size() - r.ext.size()); j >= 0 {
		x = r.ext.at(j)
	}
	return b, x
}

// bucketAt is at for bucket rings, joined into one fbucket.
func bucketAt(r *extRing[cbucket, xbucket], i int) fbucket {
	b, x := r.at(i)
	return fbucket{cbucket: b, x: x}
}

func pushBucket(r *extRing[cbucket, xbucket], b fbucket) (evicted cbucket, ok bool) {
	return r.push(b.cbucket, b.x, b.x.n > 0)
}

func clampUint32(v int64) uint32 {
	switch {
	case v <= 0:
		return 0
	case v > math.MaxUint32:
		return math.MaxUint32
	default:
		return uint32(v)
	}
}

// agg accumulates an open minute (from raw points) or an open hour (from
// closed minute buckets, sample weighted). Sums are float64 so long hours do
// not lose precision before the final float32 average.
type agg struct {
	open                          bool
	start                         mins
	samples                       uint64
	cpuSum, memSum, diskSum       float64
	inSum, outSum                 float64
	cpuMax, memMax, inMax, outMax float32
	memTotal, diskTotal, diskUsed uint64
	uptime                        int64

	// The extended part is weighted by extSamples, not samples: in a minute
	// where the agent was upgraded only the extended samples count.
	extSamples                           uint64
	load1Sum, swapSum, readSum, writeSum float64
	load1Max, readMax, writeMax          float32
}

func (a *agg) begin(start mins) {
	*a = agg{open: true, start: start}
}

func (a *agg) addPoint(p rawPoint, x xpoint, smp *Sample) {
	a.samples++
	a.cpuSum += float64(p.cpu)
	a.memSum += float64(p.mem)
	a.diskSum += float64(p.disk)
	a.inSum += float64(p.in)
	a.outSum += float64(p.out)
	a.cpuMax = max(a.cpuMax, p.cpu)
	a.memMax = max(a.memMax, p.mem)
	a.inMax = max(a.inMax, p.in)
	a.outMax = max(a.outMax, p.out)
	a.memTotal = smp.MemTotalBytes
	a.diskTotal = smp.DiskTotalBytes
	a.diskUsed = smp.DiskUsedBytes
	a.uptime = smp.UptimeSeconds
	if x.ok {
		a.extSamples++
		a.load1Sum += float64(x.load1)
		a.swapSum += float64(x.swap)
		a.readSum += float64(x.read)
		a.writeSum += float64(x.write)
		a.load1Max = max(a.load1Max, x.load1)
		a.readMax = max(a.readMax, x.read)
		a.writeMax = max(a.writeMax, x.write)
	}
}

func (a *agg) addBucket(b fbucket) {
	w := float64(b.samples)
	a.samples += uint64(b.samples)
	a.cpuSum += float64(b.cpuAvg) * w
	a.memSum += float64(b.memAvg) * w
	a.diskSum += float64(b.diskAvg) * w
	a.inSum += float64(b.inAvg) * w
	a.outSum += float64(b.outAvg) * w
	a.cpuMax = max(a.cpuMax, b.cpuMax)
	a.memMax = max(a.memMax, b.memMax)
	a.inMax = max(a.inMax, b.inMax)
	a.outMax = max(a.outMax, b.outMax)
	a.memTotal = b.memTotal
	a.diskTotal = b.diskTotal
	a.diskUsed = b.diskUsed
	a.uptime = int64(b.uptime)
	if x := b.x; x.n > 0 {
		xw := float64(x.n)
		a.extSamples += uint64(x.n)
		a.load1Sum += float64(x.load1Avg) * xw
		a.swapSum += float64(x.swapAvg) * xw
		a.readSum += float64(x.readAvg) * xw
		a.writeSum += float64(x.writeAvg) * xw
		a.load1Max = max(a.load1Max, x.load1Max)
		a.readMax = max(a.readMax, x.readMax)
		a.writeMax = max(a.writeMax, x.writeMax)
	}
}

func (a *agg) bucket() fbucket {
	b := fbucket{cbucket: cbucket{
		memTotal:  a.memTotal,
		diskTotal: a.diskTotal,
		diskUsed:  a.diskUsed,
		start:     a.start,
		uptime:    clampUint32(a.uptime),
		samples:   clampUint32(int64(min(a.samples, math.MaxUint32))),
		cpuMax:    a.cpuMax,
		memMax:    a.memMax,
		inMax:     a.inMax,
		outMax:    a.outMax,
	}}
	if a.samples > 0 {
		n := float64(a.samples)
		b.cpuAvg = float32(a.cpuSum / n)
		b.memAvg = float32(a.memSum / n)
		b.diskAvg = float32(a.diskSum / n)
		b.inAvg = float32(a.inSum / n)
		b.outAvg = float32(a.outSum / n)
	}
	if a.extSamples > 0 {
		n := float64(a.extSamples)
		b.x = xbucket{
			n:        clampUint32(int64(min(a.extSamples, math.MaxUint32))),
			load1Avg: float32(a.load1Sum / n),
			load1Max: a.load1Max,
			swapAvg:  float32(a.swapSum / n),
			readAvg:  float32(a.readSum / n),
			readMax:  a.readMax,
			writeAvg: float32(a.writeSum / n),
			writeMax: a.writeMax,
		}
	}
	return b
}

// stepAcc averages everything that falls into one Series step. The extended
// fields have their own weight xw, so a step only gets extended values from
// samples that carried them.
type stepAcc struct {
	w                       float64
	cpu, mem, disk, in, out float64

	xw                       float64
	load1, swap, read, write float64
}

func (s *stepAcc) addPoint(p rawPoint, x xpoint) {
	s.w++
	s.cpu += float64(p.cpu)
	s.mem += float64(p.mem)
	s.disk += float64(p.disk)
	s.in += float64(p.in)
	s.out += float64(p.out)
	if x.ok {
		s.xw++
		s.load1 += float64(x.load1)
		s.swap += float64(x.swap)
		s.read += float64(x.read)
		s.write += float64(x.write)
	}
}

// addBucket weights by sample count. A persisted bucket with Samples == 0
// (for example backfilled history) still counts once rather than vanishing.
// Extended values are weighted by their own count and skipped when it is 0.
func (s *stepAcc) addBucket(b fbucket) {
	w := float64(max(b.samples, 1))
	s.w += w
	s.cpu += float64(b.cpuAvg) * w
	s.mem += float64(b.memAvg) * w
	s.disk += float64(b.diskAvg) * w
	s.in += float64(b.inAvg) * w
	s.out += float64(b.outAvg) * w
	if x := b.x; x.n > 0 {
		xw := float64(x.n)
		s.xw += xw
		s.load1 += float64(x.load1Avg) * xw
		s.swap += float64(x.swapAvg) * xw
		s.read += float64(x.readAvg) * xw
		s.write += float64(x.writeAvg) * xw
	}
}
