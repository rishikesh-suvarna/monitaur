package app

import (
	"testing"
	"time"

	"backend/directory"
	"backend/store"
)

func TestSilenced(t *testing.T) {
	const (
		org, otherOrg                = int64(1), int64(2)
		prodServer, devServer, other = int64(10), int64(11), int64(20)
		check, otherCheck            = int64(100), int64(101)
	)
	start := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	inside := start.Add(30 * time.Minute)

	window := func(mut func(*store.MaintenanceWindow)) store.MaintenanceWindow {
		w := store.MaintenanceWindow{ID: 1, OrgID: org, Name: "deploy", StartsAt: start, EndsAt: end}
		mut(&w)
		return w
	}
	scopeAll := window(func(w *store.MaintenanceWindow) { w.ScopeAll = true })

	tests := []struct {
		name     string
		windows  []store.MaintenanceWindow
		org      int64
		serverID int64
		checkID  int64
		at       time.Time
		want     bool
	}{
		{name: "no windows", org: org, serverID: prodServer, at: inside},
		{name: "scope all covers a server", windows: []store.MaintenanceWindow{scopeAll}, org: org, serverID: prodServer, at: inside, want: true},
		{name: "scope all covers a check", windows: []store.MaintenanceWindow{scopeAll}, org: org, checkID: check, at: inside, want: true},
		{name: "nothing identified", windows: []store.MaintenanceWindow{scopeAll}, org: org, at: inside},
		{name: "listed server", org: org, serverID: prodServer, at: inside, want: true,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeServerIDs = []int64{prodServer} })}},
		{name: "unlisted server", org: org, serverID: devServer, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeServerIDs = []int64{prodServer} })}},
		{name: "shared tag, case-insensitive", org: org, serverID: prodServer, at: inside, want: true,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeTags = []string{"PROD"} })}},
		{name: "no shared tag", org: org, serverID: devServer, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeTags = []string{"prod"} })}},
		{name: "tags never come from another org's server", org: org, serverID: other, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeTags = []string{"prod"} })}},
		{name: "listed check", org: org, checkID: check, at: inside, want: true,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeCheckIDs = []int64{check} })}},
		{name: "unlisted check", org: org, checkID: otherCheck, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeCheckIDs = []int64{check} })}},
		{name: "check scope does not cover servers", org: org, serverID: prodServer, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeCheckIDs = []int64{prodServer} })}},
		{name: "server scope does not cover checks", org: org, checkID: prodServer, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.ScopeServerIDs = []int64{prodServer} })}},
		{name: "another org's window", org: org, serverID: prodServer, at: inside,
			windows: []store.MaintenanceWindow{window(func(w *store.MaintenanceWindow) { w.OrgID, w.ScopeAll = otherOrg, true })}},
		{name: "starts_at is inclusive", windows: []store.MaintenanceWindow{scopeAll}, org: org, serverID: prodServer, at: start, want: true},
		{name: "just before starts_at", windows: []store.MaintenanceWindow{scopeAll}, org: org, serverID: prodServer, at: start.Add(-time.Nanosecond)},
		{name: "just before ends_at", windows: []store.MaintenanceWindow{scopeAll}, org: org, serverID: prodServer, at: end.Add(-time.Nanosecond), want: true},
		{name: "ends_at is exclusive", windows: []store.MaintenanceWindow{scopeAll}, org: org, serverID: prodServer, at: end},
		{name: "one active window among ended and scheduled", org: org, serverID: prodServer, at: inside, want: true,
			windows: []store.MaintenanceWindow{
				window(func(w *store.MaintenanceWindow) {
					w.ID, w.ScopeAll, w.StartsAt, w.EndsAt = 2, true, start.Add(-2*time.Hour), start.Add(-time.Hour)
				}),
				window(func(w *store.MaintenanceWindow) {
					w.ID, w.ScopeAll, w.StartsAt, w.EndsAt = 3, true, end, end.Add(time.Hour)
				}),
				window(func(w *store.MaintenanceWindow) { w.ID, w.ScopeTags = 4, []string{"prod"} }),
			}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := directory.New(nil)
			dir.PutServer(store.Server{ID: prodServer, OrgID: org, Tags: []string{"prod", "eu"}, TokenHash: "h-prod"})
			dir.PutServer(store.Server{ID: devServer, OrgID: org, Tags: []string{"dev"}, TokenHash: "h-dev"})
			dir.PutServer(store.Server{ID: other, OrgID: otherOrg, Tags: []string{"prod"}, TokenHash: "h-other"})
			for _, w := range tc.windows {
				dir.PutMaintenance(w)
			}
			a := &App{dir: dir}
			if got := a.silenced(tc.org, tc.serverID, tc.checkID, tc.at); got != tc.want {
				t.Fatalf("silenced(org %d, server %d, check %d, %s) = %v, want %v",
					tc.org, tc.serverID, tc.checkID, tc.at.Format(time.RFC3339Nano), got, tc.want)
			}
		})
	}
}
