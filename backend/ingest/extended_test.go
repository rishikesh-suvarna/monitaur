package ingest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"backend/metrics"
	"backend/processes"
)

var now = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func decodeMetrics(t *testing.T, data string) metrics.Sample {
	t.Helper()
	var md metricData
	if err := json.Unmarshal([]byte(data), &md); err != nil {
		t.Fatal(err)
	}
	return md.sample(now)
}

func TestMetricDataExtended(t *testing.T) {
	const base = `"cpu":{"usage":12,"cores":2},"memory":{"total":8,"used":4,"used_percent":50},
		"disk":{"total":100,"used":60,"used_percent":60},"network":{"bytes_sent":10,"bytes_recv":20},"uptime":99`
	tests := []struct {
		name         string
		data         string
		wantExtended bool
		check        func(t *testing.T, s metrics.Sample)
	}{
		{
			name: "older agent", data: `{` + base + `}`,
			check: func(t *testing.T, s metrics.Sample) {
				if s.Mounts != nil || s.Interfaces != nil || s.Load1 != 0 || s.DiskReadTotal != 0 {
					t.Fatalf("older agent sample has extended values: %+v", s)
				}
			},
		},
		{
			name: "F6 agent", wantExtended: true,
			data: `{` + base + `,"load":{"load1":0.52,"load5":0.4,"load15":0.31},
				"swap":{"total":2147483648,"used":1048576,"used_percent":0.05},
				"disk_io":{"read_bytes":123456789,"write_bytes":987654321},
				"mounts":[{"path":"/","fstype":"ext4","total":1000,"used":500,"used_percent":50}],
				"interfaces":[{"name":"eth0","bytes_sent":1,"bytes_recv":2}]}`,
			check: func(t *testing.T, s metrics.Sample) {
				if s.Load1 != 0.52 || s.Load5 != 0.4 || s.Load15 != 0.31 || s.SwapTotalBytes != 2147483648 || s.SwapUsedBytes != 1048576 ||
					s.SwapPercent != 0.05 || s.DiskReadTotal != 123456789 || s.DiskWriteTotal != 987654321 {
					t.Fatalf("scalars = %+v", s)
				}
				wantMount := metrics.Mount{Path: "/", FSType: "ext4", TotalBytes: 1000, UsedBytes: 500, UsedPercent: 50}
				if len(s.Mounts) != 1 || s.Mounts[0] != wantMount {
					t.Fatalf("mounts = %+v", s.Mounts)
				}
				if len(s.Interfaces) != 1 || s.Interfaces[0] != (metrics.IfaceCounters{Name: "eth0", RxTotal: 2, TxTotal: 1}) {
					t.Fatalf("interfaces = %+v", s.Interfaces)
				}
			},
		},
		{
			name: "partial extended block (no disk IO on this platform)", wantExtended: true,
			data: `{` + base + `,"load":{"load1":1,"load5":1,"load15":1},"swap":{"total":1,"used":0,"used_percent":0}}`,
			check: func(t *testing.T, s metrics.Sample) {
				if s.Load1 != 1 || s.DiskReadTotal != 0 {
					t.Fatalf("partial = %+v", s)
				}
			},
		},
		{
			name: "empty lists stay empty, not nil", data: `{` + base + `,"mounts":[],"interfaces":[]}`,
			check: func(t *testing.T, s metrics.Sample) {
				if s.Mounts == nil || s.Interfaces == nil || len(s.Mounts) != 0 || len(s.Interfaces) != 0 {
					t.Fatalf("empty lists = %#v %#v", s.Mounts, s.Interfaces)
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := decodeMetrics(t, tc.data)
			if s.CPUPercent != 12 || s.NetRxTotal != 20 || !s.Time.Equal(now) || s.Extended != tc.wantExtended {
				t.Fatalf("base = %+v, extended %v want %v", s, s.Extended, tc.wantExtended)
			}
			tc.check(t, s)
		})
	}
}

func TestMetricDataBounds(t *testing.T) {
	longPath := "/" + strings.Repeat("é", maxMountPathLen) // multi-byte, must not be cut mid-rune
	var mounts, ifaces []string
	for i := range metrics.MaxMounts + 4 {
		mounts = append(mounts, fmt.Sprintf(`{"path":%q,"fstype":%q}`, longPath, strings.Repeat("x", 100)))
		ifaces = append(ifaces, fmt.Sprintf(`{"name":"%s%d"}`, strings.Repeat("n", 100), i))
	}
	s := decodeMetrics(t, `{"mounts":[`+strings.Join(mounts, ",")+`],"interfaces":[`+strings.Join(ifaces, ",")+`]}`)
	if len(s.Mounts) != metrics.MaxMounts || len(s.Interfaces) != metrics.MaxInterfaces {
		t.Fatalf("lists = %d mounts, %d interfaces; want %d and %d", len(s.Mounts), len(s.Interfaces), metrics.MaxMounts, metrics.MaxInterfaces)
	}
	m := s.Mounts[0]
	if n := utf8.RuneCountInString(m.Path); n != maxMountPathLen || !utf8.ValidString(m.Path) {
		t.Fatalf("path is %d runes (valid %v), want %d", n, utf8.ValidString(m.Path), maxMountPathLen)
	}
	if len(m.FSType) != maxFSTypeLen || len(s.Interfaces[0].Name) != maxIfaceNameLen {
		t.Fatalf("fstype %d, iface name %d; want %d and %d", len(m.FSType), len(s.Interfaces[0].Name), maxFSTypeLen, maxIfaceNameLen)
	}
}

func TestProcessDataSnapshot(t *testing.T) {
	var procs []string
	for i := range processes.MaxProcesses + 10 {
		procs = append(procs, fmt.Sprintf(`{"pid":%d,"name":"postgres","user":"postgres","cpu":12.5,"mem":3.1,"rss":123456,"cmd":%q}`,
			i+1, "postgres -D /var/lib/"+strings.Repeat("d", 300)))
	}
	procs[0] = `{"pid":1,"name":"bad","cpu":-5,"mem":-1}`
	var pd processData
	if err := json.Unmarshal([]byte(`{"total":312,"processes":[`+strings.Join(procs, ",")+`]}`), &pd); err != nil {
		t.Fatal(err)
	}
	snap := pd.snapshot(now)
	if !snap.At.Equal(now) || snap.Total != 312 || len(snap.Processes) != processes.MaxProcesses {
		t.Fatalf("snapshot at %s total %d with %d processes", snap.At, snap.Total, len(snap.Processes))
	}
	if p := snap.Processes[0]; p.CPU != 0 || p.Mem != 0 {
		t.Fatalf("negative percentages kept: %+v", p)
	}
	p := snap.Processes[1]
	if p.PID != 2 || p.Name != "postgres" || p.User != "postgres" || p.CPU != 12.5 || p.Mem != 3.1 || p.RSS != 123456 {
		t.Fatalf("process = %+v", p)
	}
	if len(p.Cmd) != processes.MaxCmdLen || !strings.HasPrefix(p.Cmd, "postgres -D /var/lib/") {
		t.Fatalf("cmd is %d chars, want %d", len(p.Cmd), processes.MaxCmdLen)
	}

	// A total smaller than the list itself is not believable.
	var small processData
	if err := json.Unmarshal([]byte(`{"total":-3,"processes":[{"pid":1},{"pid":2}]}`), &small); err != nil {
		t.Fatal(err)
	}
	if snap := small.snapshot(now); snap.Total != 2 {
		t.Fatalf("total = %d, want the list length 2", snap.Total)
	}
}

func TestClip(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exactly", 7, "exactly"},
		{"truncate me", 8, "truncate"},
		{"ééé", 2, "éé"},
		{"", 3, ""},
	}
	for _, tc := range tests {
		if got := clip(tc.in, tc.n); got != tc.want {
			t.Errorf("clip(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

func TestProcessesMessageFlow(t *testing.T) {
	_, _, rec, url := newTestHub(t)
	ws, _, err := dial(t, url, http.Header{"Authorization": {"Bearer " + goodToken}})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{
		`{"type":"processes","data":{"total":312,"processes":[{"pid":1,"name":"postgres","user":"postgres","cpu":12.5,"mem":3.1,"rss":123456,"cmd":"postgres -D /var/lib/x"}]}}`,
		`{"type":"processes","data":"not an object"}`,
	} {
		if err := ws.WriteMessage(websocket.TextMessage, []byte(m)); err != nil {
			t.Fatal(err)
		}
	}
	// A metrics message after both proves the bad one was read and dropped.
	if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"metrics","data":{"cpu":{"usage":1}}}`)); err != nil {
		t.Fatal(err)
	}
	eventually(t, "sample after processes", func() bool { n, _, _ := rec.snapshot(); return n == 1 })
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.snapshots) != 1 || rec.snapshots[0].Total != 312 || rec.snapshots[0].Processes[0].Name != "postgres" {
		t.Fatalf("snapshots = %+v", rec.snapshots)
	}
}
