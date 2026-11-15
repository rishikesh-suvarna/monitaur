package alerting

import "time"

type phase uint8

const (
	phaseOK phase = iota
	phasePending
	phaseFiring
	phaseRecovering
)

type transition uint8

const (
	stay transition = iota
	fire
	resolve
)

// tracker is the state machine of one threshold rule on one server:
//
//	ok -> pending -> firing <-> recovering -> ok
//
// It has no clock and does no I/O so Engine and Preview share it. The engine
// feeds live points with start == at == now; Preview feeds a bucket whose
// value covers [start, at).
type tracker struct {
	phase       phase
	since       time.Time // pending: breach start; recovering: recovery start
	peak        float64   // worst breaching value since the breach began
	last        float64
	samplesOver int
}

func (t *tracker) observe(r Rule, v float64, start, at time.Time) transition {
	t.last = v
	breach := r.breached(v)
	switch t.phase {
	case phaseOK:
		if !breach {
			return stay
		}
		t.phase, t.since, t.peak, t.samplesOver = phasePending, start, v, 1
		return t.checkHeld(r, at)
	case phasePending:
		if !breach {
			*t = tracker{}
			return stay
		}
		t.over(r, v)
		return t.checkHeld(r, at)
	case phaseFiring:
		if breach {
			t.over(r, v)
			return stay
		}
		t.phase, t.since = phaseRecovering, start
		return t.checkRecovered(r, at)
	case phaseRecovering:
		if breach {
			// Same incident: a dip shorter than AutoResolve is not a recovery.
			t.phase = phaseFiring
			t.over(r, v)
			return stay
		}
		return t.checkRecovered(r, at)
	default:
		return stay
	}
}

func (t *tracker) over(r Rule, v float64) {
	t.peak = r.worse(t.peak, v)
	t.samplesOver++
}

func (t *tracker) checkHeld(r Rule, at time.Time) transition {
	if at.Sub(t.since) < r.For {
		return stay
	}
	t.phase = phaseFiring
	return fire
}

func (t *tracker) checkRecovered(r Rule, at time.Time) transition {
	if !t.recovered(r, at) {
		return stay
	}
	t.phase = phaseOK
	return resolve
}

// recovered reports whether a recovering tracker has stayed under the
// threshold for AutoResolve by at. Tick uses it to resolve incidents whose
// agent stopped sending samples while recovering.
func (t *tracker) recovered(r Rule, at time.Time) bool {
	return t.phase == phaseRecovering && at.Sub(t.since) >= r.AutoResolve
}
