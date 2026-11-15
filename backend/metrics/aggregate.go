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

func (p rawPoint) point() Point {
	return Point{
		Time:      time.Unix(0, p.t).UTC(),
		CPU:       p.cpu,
		Mem:       p.mem,
		Disk:      p.disk,
		NetInBps:  p.in,
		NetOutBps: p.out,
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

func (b cbucket) toBucket(serverID int64, res Resolution) Bucket {
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
	}
}

func compactBucket(b Bucket) cbucket {
	return cbucket{
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
	}
}

// fuller picks between two versions of the same bucket (memory vs History).
// They only collide around a restart, where each side holds a disjoint part
// of the period, so the side with more samples is the better partial and we
// never double count. Ties go to a (memory).
func fuller(a, b cbucket) cbucket {
	if b.samples > a.samples {
		return b
	}
	return a
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
}

func (a *agg) begin(start mins) {
	*a = agg{open: true, start: start}
}

func (a *agg) addPoint(p rawPoint, smp *Sample) {
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
}

func (a *agg) addBucket(b cbucket) {
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
}

func (a *agg) bucket() cbucket {
	b := cbucket{
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
	}
	if a.samples > 0 {
		n := float64(a.samples)
		b.cpuAvg = float32(a.cpuSum / n)
		b.memAvg = float32(a.memSum / n)
		b.diskAvg = float32(a.diskSum / n)
		b.inAvg = float32(a.inSum / n)
		b.outAvg = float32(a.outSum / n)
	}
	return b
}

// stepAcc averages everything that falls into one Series step.
type stepAcc struct {
	w                       float64
	cpu, mem, disk, in, out float64
}

func (s *stepAcc) addPoint(p rawPoint) {
	s.w++
	s.cpu += float64(p.cpu)
	s.mem += float64(p.mem)
	s.disk += float64(p.disk)
	s.in += float64(p.in)
	s.out += float64(p.out)
}

// addBucket weights by sample count. A persisted bucket with Samples == 0
// (for example backfilled history) still counts once rather than vanishing.
func (s *stepAcc) addBucket(b cbucket) {
	w := float64(max(b.samples, 1))
	s.w += w
	s.cpu += float64(b.cpuAvg) * w
	s.mem += float64(b.memAvg) * w
	s.disk += float64(b.diskAvg) * w
	s.in += float64(b.inAvg) * w
	s.out += float64(b.outAvg) * w
}
