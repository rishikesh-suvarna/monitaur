package processes

import (
	"sync"
	"testing"
	"time"
)

var at = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func snapshot(total int, pids ...int32) Snapshot {
	snap := Snapshot{At: at, Total: total}
	for _, pid := range pids {
		snap.Processes = append(snap.Processes, Process{PID: pid, Name: "p"})
	}
	return snap
}

func TestStore(t *testing.T) {
	tests := []struct {
		name      string
		ops       func(s *Store)
		server    int64
		wantOK    bool
		wantTotal int
		wantPIDs  int
	}{
		{"nothing received yet", func(*Store) {}, 1, false, 0, 0},
		{"put then get", func(s *Store) { s.Put(1, snapshot(312, 1, 2)) }, 1, true, 312, 2},
		{"latest snapshot wins", func(s *Store) {
			s.Put(1, snapshot(10, 1, 2, 3))
			s.Put(1, snapshot(11, 4))
		}, 1, true, 11, 1},
		{"servers are independent", func(s *Store) { s.Put(2, snapshot(5, 1)) }, 1, false, 0, 0},
		{"forget drops the snapshot", func(s *Store) {
			s.Put(1, snapshot(10, 1))
			s.Forget(1)
		}, 1, false, 0, 0},
		{"a late put after forget is ignored", func(s *Store) {
			s.Forget(1)
			s.Put(1, snapshot(10, 1))
		}, 1, false, 0, 0},
		{"put is bounded", func(s *Store) {
			pids := make([]int32, MaxProcesses+5)
			for i := range pids {
				pids[i] = int32(i + 1)
			}
			s.Put(1, snapshot(500, pids...))
		}, 1, true, 500, MaxProcesses},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := New()
			tc.ops(s)
			got, ok := s.Get(tc.server)
			if ok != tc.wantOK || got.Total != tc.wantTotal || len(got.Processes) != tc.wantPIDs {
				t.Fatalf("Get = ok %v total %d processes %d, want %v %d %d", ok, got.Total, len(got.Processes), tc.wantOK, tc.wantTotal, tc.wantPIDs)
			}
		})
	}
}

func TestStoreConcurrent(t *testing.T) {
	const (
		servers = 8
		rounds  = 200
	)
	s := New()
	var wg sync.WaitGroup
	for id := int64(1); id <= servers; id++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for i := range rounds {
				s.Put(id, snapshot(i, 1, 2, 3))
			}
		}()
		go func() {
			defer wg.Done()
			for range rounds {
				if snap, ok := s.Get(id); ok && len(snap.Processes) != 3 {
					t.Errorf("torn snapshot: %d processes", len(snap.Processes))
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.Forget(servers)
	}()
	wg.Wait()
	if _, ok := s.Get(servers); ok {
		t.Fatal("forgotten server still has a snapshot")
	}
}
