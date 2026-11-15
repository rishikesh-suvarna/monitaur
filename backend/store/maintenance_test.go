package store_test

import (
	"errors"
	"testing"
	"time"

	"backend/store"
)

func TestMaintenanceWindowsCRUD(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "Ana", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	other, _ := st.UpsertUser(c, "uid-2", "two@example.com", "", true)
	otherOrg, _ := st.EnsurePersonalOrg(c, other.ID, "free")
	srv, _ := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "db", TokenHash: "h"}, 0)

	start := time.Date(2026, 11, 15, 22, 0, 0, 0, time.UTC)
	const maxWindows = 2
	created, err := st.CreateMaintenanceWindow(c, store.MaintenanceWindow{OrgID: org.ID, Name: "db upgrade",
		ScopeServerIDs: []int64{srv.ID}, ScopeTags: []string{"prod"}, ScopeCheckIDs: []int64{42},
		StartsAt: start, EndsAt: start.Add(2 * time.Hour), CreatedByID: &u.ID}, maxWindows)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 || created.CreatedBy == nil || *created.CreatedBy != "Ana" || created.ScopeAll ||
		len(created.ScopeServerIDs) != 1 || created.ScopeTags[0] != "prod" || created.ScopeCheckIDs[0] != 42 ||
		!created.StartsAt.Equal(start) || created.CreatedAt.IsZero() {
		t.Fatalf("created = %+v", created)
	}

	// Nil scopes come back as empty lists, never null.
	all, err := st.CreateMaintenanceWindow(c, store.MaintenanceWindow{OrgID: org.ID, Name: "everything", ScopeAll: true,
		StartsAt: start, EndsAt: start.Add(time.Hour)}, maxWindows)
	if err != nil || all.ScopeServerIDs == nil || all.ScopeTags == nil || all.ScopeCheckIDs == nil || all.CreatedBy != nil {
		t.Fatalf("scope-all window = %+v, %v", all, err)
	}

	// The cap counts every window of the org, ended ones included.
	if _, err := st.CreateMaintenanceWindow(c, store.MaintenanceWindow{OrgID: org.ID, Name: "third", ScopeAll: true,
		StartsAt: start, EndsAt: start.Add(time.Hour)}, maxWindows); !errors.Is(err, store.ErrLimitReached) {
		t.Fatalf("over-cap create error = %v, want ErrLimitReached", err)
	}
	// The table rejects an empty or inverted range even if the API missed it.
	if _, err := st.CreateMaintenanceWindow(c, store.MaintenanceWindow{OrgID: otherOrg.ID, Name: "inverted", ScopeAll: true,
		StartsAt: start, EndsAt: start}, maxWindows); err == nil {
		t.Fatal("window ending at its start was accepted")
	}

	listed, err := st.ListOrgMaintenanceWindows(c, org.ID)
	if err != nil || len(listed) != 2 || listed[0].ID != created.ID {
		t.Fatalf("org list = %+v, %v", listed, err)
	}
	everyOrg, err := st.ListAllMaintenanceWindows(c)
	if err != nil || len(everyOrg) != 2 {
		t.Fatalf("all list = %+v, %v", everyOrg, err)
	}

	// End now: only the end moves; scope and creator are kept.
	now := start.Add(30 * time.Minute)
	created.EndsAt = now
	updated, err := st.UpdateMaintenanceWindow(c, created)
	if err != nil || !updated.EndsAt.Equal(now) || len(updated.ScopeServerIDs) != 1 || updated.CreatedBy == nil {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if got, err := st.GetMaintenanceWindow(c, org.ID, created.ID); err != nil || !got.EndsAt.Equal(now) {
		t.Fatalf("get after update = %+v, %v", got, err)
	}

	// Other tenants can neither read, change nor delete it.
	if _, err := st.GetMaintenanceWindow(c, otherOrg.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant get error = %v", err)
	}
	stolen := created
	stolen.OrgID, stolen.Name = otherOrg.ID, "pwned"
	if _, err := st.UpdateMaintenanceWindow(c, stolen); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant update error = %v", err)
	}
	if err := st.DeleteMaintenanceWindow(c, otherOrg.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant delete error = %v", err)
	}

	if err := st.DeleteMaintenanceWindow(c, org.ID, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteMaintenanceWindow(c, org.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete error = %v", err)
	}
	// Deleting frees a slot under the cap.
	if _, err := st.CreateMaintenanceWindow(c, store.MaintenanceWindow{OrgID: org.ID, Name: "again", ScopeAll: true,
		StartsAt: start, EndsAt: start.Add(time.Hour)}, maxWindows); err != nil {
		t.Fatalf("create after delete: %v", err)
	}
}

func TestMarkIncidentSilenced(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	srv, _ := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "db", TokenHash: "h"}, 0)
	id, err := st.OpenIncident(c, store.NewIncident{OrgID: org.ID, ServerID: srv.ID, RuleName: "cpu", Metric: "cpu",
		Severity: "warning", Threshold: 80, Peak: 90, LastValue: 90, SamplesOver: 1, StartedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if inc, err := st.GetIncident(c, org.ID, id); err != nil || inc.Silenced {
		t.Fatalf("new incident = %+v, %v (want not silenced)", inc, err)
	}
	if err := st.MarkIncidentSilenced(c, id); err != nil {
		t.Fatal(err)
	}
	list, _, err := st.ListIncidents(c, org.ID, store.IncidentFilter{State: "all"})
	if err != nil || len(list) != 1 || !list[0].Silenced {
		t.Fatalf("list after silencing = %+v, %v", list, err)
	}
}

func TestMaintenanceStates(t *testing.T) {
	start := time.Date(2026, 11, 15, 22, 0, 0, 0, time.UTC)
	w := store.MaintenanceWindow{StartsAt: start, EndsAt: start.Add(time.Hour)}
	tests := []struct {
		at   time.Time
		want string
	}{
		{start.Add(-time.Second), store.MaintenanceScheduled},
		{start, store.MaintenanceActive},
		{start.Add(time.Hour - time.Nanosecond), store.MaintenanceActive},
		{start.Add(time.Hour), store.MaintenanceEnded},
	}
	for _, tc := range tests {
		if got := w.State(tc.at); got != tc.want {
			t.Errorf("State(%s) = %s, want %s", tc.at.Format(time.RFC3339Nano), got, tc.want)
		}
		if active := w.ActiveAt(tc.at); active != (tc.want == store.MaintenanceActive) {
			t.Errorf("ActiveAt(%s) = %v, disagrees with State %s", tc.at.Format(time.RFC3339Nano), active, tc.want)
		}
	}
}
