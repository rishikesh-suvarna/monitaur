package metrics

// ringMinAlloc is the first allocation of a ring. Rings grow by doubling up to
// their limit, so a server that has only just connected does not pay for a
// full day of buckets.
const ringMinAlloc = 16

// ring is a bounded FIFO that overwrites its oldest element when full.
// Not safe for concurrent use; callers hold the owning serverState lock.
type ring[T any] struct {
	buf   []T
	head  int // index of the oldest element
	n     int
	limit int
}

func newRing[T any](limit int) ring[T] {
	return ring[T]{limit: max(limit, 1)}
}

// push appends v and reports the element it evicted, if any.
func (r *ring[T]) push(v T) (evicted T, ok bool) {
	if r.n == len(r.buf) && len(r.buf) < r.limit {
		r.grow()
	}
	if r.n == len(r.buf) {
		evicted = r.buf[r.head]
		r.buf[r.head] = v
		r.head = (r.head + 1) % len(r.buf)
		return evicted, true
	}
	r.buf[(r.head+r.n)%len(r.buf)] = v
	r.n++
	return evicted, false
}

func (r *ring[T]) grow() {
	buf := make([]T, min(r.limit, max(ringMinAlloc, 2*len(r.buf))))
	for i := range r.n {
		buf[i] = r.at(i)
	}
	r.buf, r.head = buf, 0
}

func (r *ring[T]) size() int { return r.n }

// at returns the i-th element, 0 being the oldest.
func (r *ring[T]) at(i int) T {
	return r.buf[(r.head+i)%len(r.buf)]
}
