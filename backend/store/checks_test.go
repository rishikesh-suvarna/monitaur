package store_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"backend/checks"
	"backend/store"
)

func newCheck(orgID int64, name string) store.Check {
	return store.Check{OrgID: orgID, Name: name, Type: "http", Target: "https://example.com/" + name,
		IntervalSeconds: 60, TimeoutSeconds: 10, TLSWarnDays: 14, Enabled: true}
}

func TestChecksCRUDQuotaAndTenancy(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	other, _ := st.UpsertUser(c, "uid-2", "two@example.com", "", true)
	otherOrg, _ := st.EnsurePersonalOrg(c, other.ID, "free")

	plans, err := st.ListPlans(c)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]store.Plan{}
	for _, p := range plans {
		byID[p.ID] = p
	}
	if p := byID["free"]; p.MaxChecks != 3 || p.MinCheckIntervalSeconds != 60 {
		t.Fatalf("free plan = %+v", p)
	}
	if p := byID["legacy"]; p.MaxChecks != 0 || p.MinCheckIntervalSeconds != 30 {
		t.Fatalf("legacy plan = %+v", p)
	}

	ch, err := st.CreateChannel(c, org.ID, "slack", "ops", true, []byte(`{"webhook_url":"https://hooks.slack.com/services/T/B/X"}`), 0)
	if err != nil {
		t.Fatal(err)
	}
	var created []store.Check
	for _, name := range []string{"b-api", "a-web", "c-db"} {
		chk := newCheck(org.ID, name)
		chk.ChannelIDs = []int64{ch.ID}
		got, err := st.CreateCheck(c, chk, byID["free"].MaxChecks)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		created = append(created, got)
	}
	if _, err := st.CreateCheck(c, newCheck(org.ID, "over"), byID["free"].MaxChecks); !errors.Is(err, store.ErrLimitReached) {
		t.Fatalf("over-quota create error = %v", err)
	}
	if _, err := st.CreateCheck(c, newCheck(org.ID, "unlimited"), 0); err != nil {
		t.Fatalf("unlimited plan create: %v", err)
	}
	list, err := st.ListOrgChecks(c, org.ID)
	if err != nil || len(list) != 4 || list[0].Name != "a-web" || list[0].ChannelIDs[0] != ch.ID {
		t.Fatalf("list = %+v, %v", list, err)
	}

	upd := created[0]
	upd.Name, upd.Type, upd.Target, upd.Enabled = "api-tls", "tls", "example.com:443", false
	got, err := st.UpdateCheck(c, upd)
	if err != nil || got.Type != "tls" || got.Enabled || !got.UpdatedAt.After(created[0].UpdatedAt) {
		t.Fatalf("update = %+v, %v", got, err)
	}

	// Other tenants can neither read, edit nor delete it.
	if _, err := st.GetCheck(c, otherOrg.ID, created[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant get error = %v", err)
	}
	stolen := upd
	stolen.OrgID = otherOrg.ID
	if _, err := st.UpdateCheck(c, stolen); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant update error = %v", err)
	}
	if err := st.DeleteCheck(c, otherOrg.ID, created[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant delete error = %v", err)
	}

	// Status page check_ids are filtered to the org's checks; nil leaves them.
	foreign, _ := st.CreateCheck(c, newCheck(otherOrg.ID, "theirs"), 0)
	updOrg, err := st.UpdateOrg(c, org.ID, store.OrgPatch{StatusPage: &store.StatusPage{Enabled: true,
		CheckIDs: []int64{created[1].ID, foreign.ID, created[0].ID}}})
	// "a-web" sorts before "api-tls" (created[0] after its rename).
	if err != nil || !slices.Equal(updOrg.StatusPage.CheckIDs, []int64{created[1].ID, created[0].ID}) {
		t.Fatalf("status page check ids = %v, %v (sorted by name, foreign dropped)", updOrg.StatusPage.CheckIDs, err)
	}
	updOrg, err = st.UpdateOrg(c, org.ID, store.OrgPatch{StatusPage: &store.StatusPage{Enabled: true, Title: "t"}})
	if err != nil || len(updOrg.StatusPage.CheckIDs) != 2 {
		t.Fatalf("absent check ids cleared them: %v, %v", updOrg.StatusPage.CheckIDs, err)
	}

	// Deleting a channel unroutes it; deleting a check leaves the status page.
	if err := st.DeleteChannel(c, org.ID, ch.ID); err != nil {
		t.Fatal(err)
	}
	if after, _ := st.GetCheck(c, org.ID, created[2].ID); len(after.ChannelIDs) != 0 {
		t.Fatalf("check still routes to a deleted channel: %v", after.ChannelIDs)
	}
	if err := st.DeleteCheck(c, org.ID, created[0].ID); err != nil {
		t.Fatal(err)
	}
	if o, _ := st.GetOrg(c, org.ID); !slices.Equal(o.StatusPage.CheckIDs, []int64{created[1].ID}) {
		t.Fatalf("status page after delete = %v", o.StatusPage.CheckIDs)
	}
	all, err := st.ListAllChecks(c)
	if err != nil || len(all) != 4 {
		t.Fatalf("all checks = %d, %v", len(all), err)
	}
}

func TestCheckRollupsMergeAndRead(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	chk, err := st.CreateCheck(c, newCheck(org.ID, "api"), 0)
	if err != nil {
		t.Fatal(err)
	}
	hour := time.Now().UTC().Truncate(time.Hour).Add(-2 * time.Hour)
	day := hour.Truncate(24 * time.Hour)
	write := func(h checks.HourRollup, d checks.DayRollup) {
		t.Helper()
		if err := st.WriteCheckRollups(c, []checks.HourRollup{h, {CheckID: 999_999, Start: hour, Total: 1}},
			[]checks.DayRollup{d, {CheckID: 999_999, Day: day, Total: 1}}); err != nil {
			t.Fatalf("write rollups: %v", err)
		}
	}
	// One hour flushed in two windows: counts add up and latency averages
	// are weighted by successful probes.
	write(checks.HourRollup{CheckID: chk.ID, Start: hour, Total: 30, OK: 30, LatencyAvgMS: 10, LatencyMaxMS: 50},
		checks.DayRollup{CheckID: chk.ID, Day: day, Total: 30, OK: 30})
	write(checks.HourRollup{CheckID: chk.ID, Start: hour, Total: 30, OK: 10, LatencyAvgMS: 50, LatencyMaxMS: 90},
		checks.DayRollup{CheckID: chk.ID, Day: day, Total: 30, OK: 10})
	// An hour with no successful probe has no latency.
	write(checks.HourRollup{CheckID: chk.ID, Start: hour.Add(time.Hour), Total: 5},
		checks.DayRollup{CheckID: chk.ID, Day: day, Total: 5})

	got, err := st.ReadCheckHours(c, chk.ID, hour.Add(-time.Hour), hour.Add(2*time.Hour))
	if err != nil || len(got) != 2 {
		t.Fatalf("hours = %+v, %v", got, err)
	}
	if want := (checks.HourRollup{CheckID: chk.ID, Start: hour, Total: 60, OK: 40, LatencyAvgMS: 20, LatencyMaxMS: 90}); got[0] != want {
		t.Fatalf("merged hour = %+v, want %+v", got[0], want)
	}
	if got[1].OK != 0 || got[1].LatencyAvgMS != 0 || got[1].Total != 5 {
		t.Fatalf("failed hour = %+v", got[1])
	}
	recent, err := st.RecentCheckHours(c, hour)
	if err != nil || len(recent) != 2 {
		t.Fatalf("recent = %+v, %v", recent, err)
	}
	days, err := st.CheckUptimeDays(c, []int64{chk.ID}, day.AddDate(0, 0, -1))
	if err != nil || len(days) != 1 || days[0].Total != 65 || days[0].OK != 40 || !days[0].Day.Equal(day) {
		t.Fatalf("days = %+v, %v", days, err)
	}
	if _, err := st.ApplyCheckRetention(c); err != nil {
		t.Fatalf("retention: %v", err)
	}
	if err := st.WriteCheckRollups(c, nil, nil); err != nil {
		t.Fatalf("empty write: %v", err)
	}
}

func TestCheckIncidents(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	other, _ := st.UpsertUser(c, "uid-2", "two@example.com", "", true)
	otherOrg, _ := st.EnsurePersonalOrg(c, other.ID, "free")
	chk, _ := st.CreateCheck(c, newCheck(org.ID, "api"), 0)
	srv, _ := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "db", TokenHash: "h"}, 0)
	if _, err := st.OpenIncident(c, store.NewIncident{OrgID: org.ID, ServerID: srv.ID, RuleName: "cpu", Metric: "cpu",
		Severity: "warning", Threshold: 80, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	id, err := st.OpenCheckIncident(c, store.NewCheckIncident{OrgID: org.ID, CheckID: chk.ID, RuleName: checks.DownRuleName,
		Metric: "http", Severity: "critical", Threshold: 2, Peak: 2, LastValue: 2, SamplesOver: 2, StartedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	// A check of another org (or a deleted one) cannot get incidents.
	if _, err := st.OpenCheckIncident(c, store.NewCheckIncident{OrgID: otherOrg.ID, CheckID: chk.ID, RuleName: "x",
		Metric: "http", Severity: "critical", StartedAt: time.Now()}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant open error = %v", err)
	}

	inc, err := st.GetIncident(c, org.ID, id)
	if err != nil || inc.ServerID != nil || inc.ServerName != "api" || inc.CheckID == nil || *inc.CheckID != chk.ID ||
		inc.CheckName == nil || *inc.CheckName != "api" || inc.RuleID != nil {
		t.Fatalf("check incident = %+v, %v", inc, err)
	}
	list, counts, err := st.ListIncidents(c, org.ID, store.IncidentFilter{State: "open", CheckID: chk.ID})
	if err != nil || len(list) != 1 || list[0].ID != id || counts.Open != 2 {
		t.Fatalf("list by check = %+v counts %+v, %v", list, counts, err)
	}
	all, _, _ := st.ListIncidents(c, org.ID, store.IncidentFilter{State: "all"})
	if len(all) != 2 || all[1].ServerID == nil || *all[1].ServerID != srv.ID || all[1].CheckID != nil || all[1].ServerName != "db" {
		t.Fatalf("server incident next to a check incident = %+v", all)
	}

	// The alerting engine never loads check incidents; the scheduler does.
	engineOpen, _ := st.LoadOpenIncidents(c)
	checkOpen, _ := st.LoadOpenCheckIncidents(c)
	if len(engineOpen) != 1 || engineOpen[0].CheckID != nil || len(checkOpen) != 1 || checkOpen[0].ID != id {
		t.Fatalf("engine open %+v, check open %+v", engineOpen, checkOpen)
	}
	public, err := st.IncidentsForServices(c, org.ID, nil, []int64{chk.ID}, time.Now().Add(-time.Hour), 10)
	if err != nil || len(public) != 1 || public[0].ID != id {
		t.Fatalf("status page incidents = %+v, %v", public, err)
	}

	if err := st.SaveIncidentProgress(c, id, 5, 5, 5, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.ResolveIncident(c, id, time.Now(), string(checks.ResolvedAuto), 5, 5, nil); err != nil {
		t.Fatal(err)
	}
	if open, _ := st.LoadOpenCheckIncidents(c); len(open) != 0 {
		t.Fatalf("open after resolve = %d", len(open))
	}
	// Deleting the check deletes its incidents.
	if err := st.DeleteCheck(c, org.ID, chk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetIncident(c, org.ID, id); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("incident of a deleted check error = %v", err)
	}
}
