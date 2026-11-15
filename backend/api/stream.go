package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
)

const (
	eventServers   = "servers"
	eventIncident  = "incident"
	serversEvery   = 3 * time.Second
	pingEvery      = 15 * time.Second
	subscriberBuf  = 32
	maxSubsPerUser = 8
)

// Broker fans incident events out to SSE subscribers of an org. Server
// snapshots are computed per subscriber from memory, so no event bus is needed.
type Broker struct {
	mu     sync.Mutex
	subs   map[int64]map[*subscriber]struct{}
	byUser map[int64]int
}

type subscriber struct {
	ch     chan []byte
	userID int64
}

func NewBroker() *Broker {
	return &Broker{subs: map[int64]map[*subscriber]struct{}{}, byUser: map[int64]int{}}
}

func (b *Broker) subscribe(orgID, userID int64) (*subscriber, func(), bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byUser[userID] >= maxSubsPerUser {
		return nil, nil, false
	}
	s := &subscriber{ch: make(chan []byte, subscriberBuf), userID: userID}
	if b.subs[orgID] == nil {
		b.subs[orgID] = map[*subscriber]struct{}{}
	}
	b.subs[orgID][s] = struct{}{}
	b.byUser[userID]++
	return s, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		delete(b.subs[orgID], s)
		b.byUser[userID]--
	}, true
}

// Publish never blocks: a slow subscriber misses events (its next servers
// snapshot and a refetch catch it up).
func (b *Broker) Publish(orgID int64, event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	frame := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, data))
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs[orgID] {
		select {
		case s.ch <- frame:
		default:
		}
	}
}

func (a *API) stream(c *gin.Context) {
	p := auth.MustPrincipal(c)
	sub, unsubscribe, ok := a.Broker.subscribe(p.OrgID, p.User.ID)
	if !ok {
		fail(c, http.StatusTooManyRequests, "rate_limited", "too many open live connections")
		return
	}
	defer unsubscribe()

	w := c.Writer
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	w.WriteHeader(http.StatusOK)

	send := func(frame []byte) bool {
		if _, err := w.Write(frame); err != nil {
			return false
		}
		w.Flush()
		return true
	}
	snapshot := func() bool {
		data, err := json.Marshal(gin.H{"servers": a.liveServers(p.OrgID)})
		if err != nil {
			return false
		}
		if !send([]byte(fmt.Sprintf("event: %s\ndata: %s\n\n", eventServers, data))) {
			return false
		}
		// Checks ride the same 3 s cadence, only for orgs that have any.
		if a.Dir.CheckCount(p.OrgID) == 0 {
			return true
		}
		if data, err = json.Marshal(gin.H{"checks": a.liveChecks(p.OrgID)}); err != nil {
			return false
		}
		return send([]byte(fmt.Sprintf("event: %s\ndata: %s\n\n", eventChecks, data)))
	}
	if !snapshot() {
		return
	}
	servers := time.NewTicker(serversEvery)
	defer servers.Stop()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case frame := <-sub.ch:
			if !send(frame) {
				return
			}
		case <-servers.C:
			if !snapshot() {
				return
			}
		case <-ping.C:
			if !send([]byte(": ping\n\n")) {
				return
			}
		}
	}
}
