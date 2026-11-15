// Package processes keeps the latest top-processes snapshot each agent sent
// (docs/platform-v2.md 6.2, F9). Snapshots live in memory only: they are
// never written to the database and are dropped when a server is deleted.
package processes

import (
	"sync"
	"time"
)

// Bounds of one snapshot, enforced by ingest and again by Put so the memory
// held per server is fixed whatever the caller does.
const (
	MaxProcesses = 30  // union of the agent's top 15 by CPU and top 15 by memory
	MaxCmdLen    = 200 // characters of the command line kept
)

// Process is one entry of an agent's top list. CPU is percent of one core
// (it can exceed 100 on multi-core hosts), Mem is percent of total memory.
type Process struct {
	PID  int32   `json:"pid"`
	Name string  `json:"name"`
	User string  `json:"user"`
	CPU  float64 `json:"cpu"`
	Mem  float64 `json:"mem"`
	RSS  uint64  `json:"rss"`
	Cmd  string  `json:"cmd"`
}

// Snapshot is one processes message. At is the receive time on the backend.
type Snapshot struct {
	At        time.Time
	Total     int // processes running on the host, not just the listed ones
	Processes []Process
}

// Store holds the latest snapshot per server. It is safe for concurrent use.
//
// Server IDs are never reused, so a deleted server is remembered: a snapshot
// that was already in flight when the server was deleted is dropped instead
// of lingering in memory forever.
type Store struct {
	mu        sync.RWMutex
	latest    map[int64]Snapshot
	forgotten map[int64]struct{}
}

func New() *Store {
	return &Store{latest: make(map[int64]Snapshot), forgotten: make(map[int64]struct{})}
}

// Put replaces the server's snapshot. The store takes ownership of
// snap.Processes: callers must not modify it afterwards, and Get hands the
// same slice to readers, who must not modify it either.
func (s *Store) Put(serverID int64, snap Snapshot) {
	if len(snap.Processes) > MaxProcesses {
		snap.Processes = snap.Processes[:MaxProcesses:MaxProcesses]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, gone := s.forgotten[serverID]; gone {
		return
	}
	s.latest[serverID] = snap
}

// Get returns the server's latest snapshot; ok is false when the agent has
// not sent one (for example an agent older than F9).
func (s *Store) Get(serverID int64) (Snapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap, ok := s.latest[serverID]
	return snap, ok
}

// Forget drops a deleted server's snapshot and rejects later Puts for it.
func (s *Store) Forget(serverID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.latest, serverID)
	s.forgotten[serverID] = struct{}{}
}
