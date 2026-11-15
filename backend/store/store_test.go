package store_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"backend/database"
	"backend/metrics"
	"backend/secrets"
	"backend/store"
	"backend/testdb"
)

func newStore(t *testing.T) *store.Store {
	t.Helper()
	box, err := secrets.NewBox(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return store.New(testdb.Migrated(t), box)
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return c
}

// The legacy test reproduces the v1 GORM schema with data, exactly as it
// exists in production, then runs every migration over it.
func TestMigrateLegacyDatabase(t *testing.T) {
	pool := testdb.New(t)
	c := ctx(t)
	baseline, err := os.ReadFile("../database/migrations/00001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	up := bytes.SplitN(bytes.SplitN(baseline, []byte("-- +goose Down"), 2)[0], []byte("-- +goose Up"), 2)[1]
	if _, err := pool.Exec(c, string(up)); err != nil {
		t.Fatalf("stage legacy schema: %v", err)
	}
	const legacyToken = "11111111-1111-1111-1111-111111111111"
	for _, q := range []string{
		`INSERT INTO users (firebase_uid, email, created_at, updated_at) VALUES ('uid-a', 'a@example.com', now(), now()), ('uid-b', 'b@example.com', NULL, NULL)`,
		`INSERT INTO servers (user_id, token, name, created_at) VALUES (1, '` + legacyToken + `', 'web-01', now()), (2, 'other-token', 'b-box', NULL)`,
		`INSERT INTO metrics (time, server_id, cpu_usage, memory_percent, disk_percent, memory_total, disk_total, disk_used, uptime)
		 SELECT date_trunc('day', now() - interval '1 day') + g * interval '5 seconds', 1, 40 + g % 10, 50, 60, 8e9, 1e11, 6e10, g
		 FROM generate_series(0, 719) g`,
		`INSERT INTO alerts (server_id, type, level, message, value, threshold) VALUES (1, 'cpu', 'warning', 'spam', 90, 80)`,
	} {
		if _, err := pool.Exec(c, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}

	if err := database.Migrate(c, pool, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("migrate legacy: %v", err)
	}
	// Running again must be a no-op.
	if err := database.Migrate(c, pool, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("re-migrate: %v", err)
	}

	box, _ := secrets.NewBox(bytes.Repeat([]byte{1}, 32))
	st := store.New(pool, box)

	servers, err := st.ListAllServers(c)
	if err != nil || len(servers) != 2 {
		t.Fatalf("servers = %d, %v", len(servers), err)
	}
	// The Go hash of the legacy plaintext token must equal what SQL stored,
	// otherwise every existing agent is locked out after the upgrade.
	if servers[0].TokenHash != secrets.HashToken(legacyToken) {
		t.Fatalf("token hash mismatch: sql %s, go %s", servers[0].TokenHash, secrets.HashToken(legacyToken))
	}
	var plaintextLeft int
	if err := pool.QueryRow(c, `SELECT count(*) FROM servers WHERE token IS NOT NULL`).Scan(&plaintextLeft); err != nil || plaintextLeft != 0 {
		t.Fatalf("plaintext tokens left = %d, %v", plaintextLeft, err)
	}

	orgs, err := st.ListUserOrgs(c, 1)
	if err != nil || len(orgs) != 1 || orgs[0].Role != store.RoleOwner || orgs[0].PlanID != "legacy" || !orgs[0].Personal() {
		t.Fatalf("legacy user org = %+v, %v", orgs, err)
	}
	if servers[0].OrgID != orgs[0].ID {
		t.Fatalf("server org %d, want %d", servers[0].OrgID, orgs[0].ID)
	}

	pending, err := st.LegacyBackfillPending(c)
	if err != nil || !pending {
		t.Fatalf("backfill pending = %v, %v", pending, err)
	}
	targets, err := st.LegacyBackfillTargets(c)
	if err != nil || len(targets) != 1 {
		t.Fatalf("targets = %+v, %v", targets, err)
	}
	for range 2 { // idempotent
		if err := st.BackfillLegacyDay(c, targets[0]); err != nil {
			t.Fatalf("backfill: %v", err)
		}
	}
	day := targets[0].Day
	minutes, err := st.ReadBuckets(c, 1, metrics.Minute, day, day.Add(24*time.Hour))
	if err != nil || len(minutes) != 60 {
		t.Fatalf("minute buckets = %d, %v", len(minutes), err)
	}
	if minutes[0].Samples != 12 || minutes[0].CPUMax < minutes[0].CPUAvg {
		t.Fatalf("bucket = %+v", minutes[0])
	}
	// v1 data has no extended (F6) values: NULL in SQL, ExtSamples 0 in Go.
	if minutes[0].ExtSamples != 0 || minutes[0].Load1Avg != 0 {
		t.Fatalf("legacy bucket has extended values: %+v", minutes[0])
	}
	var extRows int
	if err := pool.QueryRow(c, `SELECT count(*) FROM metrics_1m WHERE ext_samples <> 0 OR load1_avg IS NOT NULL
		OR swap_avg IS NOT NULL OR disk_read_bps_avg IS NOT NULL OR disk_write_bps_max IS NOT NULL`).Scan(&extRows); err != nil || extRows != 0 {
		t.Fatalf("legacy rows with extended values = %d, %v", extRows, err)
	}
	hours, err := st.ReadBuckets(c, 1, metrics.Hour, day, day.Add(24*time.Hour))
	if err != nil || len(hours) != 1 || hours[0].Samples != 720 {
		t.Fatalf("hour buckets = %+v, %v", hours, err)
	}
	uptime, err := st.UptimeDays(c, []int64{1}, day)
	if err != nil || len(uptime) != 1 || uptime[0].MinutesUp != 60 {
		t.Fatalf("uptime = %+v, %v (re-run must not double count)", uptime, err)
	}
	if err := st.MarkJobDone(c, store.LegacyBackfillJob()); err != nil {
		t.Fatal(err)
	}
	if pending, _ := st.LegacyBackfillPending(c); pending {
		t.Fatal("backfill still pending after MarkJobDone")
	}

	// Deleting a server with legacy rows must cascade, not fail on old FKs.
	if err := st.DeleteServer(c, orgs[0].ID, 1); err != nil {
		t.Fatalf("delete server with legacy metrics: %v", err)
	}
}

func TestUsersOrgsAndQuotas(t *testing.T) {
	st, c := newStore(t), ctx(t)

	u, err := st.UpsertUser(c, "uid-1", "one@example.com", "One", false)
	if err != nil || u.ID == 0 || u.EmailVerified {
		t.Fatalf("upsert = %+v, %v", u, err)
	}
	again, err := st.UpsertUser(c, "uid-1", "one@example.com", "Ignored", true)
	if err != nil || again.ID != u.ID || !again.EmailVerified || again.DisplayName != "One" {
		t.Fatalf("re-upsert = %+v, %v", again, err)
	}
	unchanged, err := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	if err != nil || unchanged.ID != u.ID {
		t.Fatalf("no-op upsert = %+v, %v", unchanged, err)
	}

	org, err := st.EnsurePersonalOrg(c, u.ID, "free")
	if err != nil {
		t.Fatal(err)
	}
	same, err := st.EnsurePersonalOrg(c, u.ID, "free")
	if err != nil || same.ID != org.ID {
		t.Fatalf("EnsurePersonalOrg not idempotent: %d vs %d, %v", same.ID, org.ID, err)
	}
	plan, err := st.GetPlan(c, "free")
	if err != nil || plan.MaxServers != 3 {
		t.Fatalf("plan = %+v, %v", plan, err)
	}

	for i := range plan.MaxServers {
		if _, err := st.CreateServer(c, store.NewServer{OrgID: org.ID, CreatedBy: u.ID, Name: "s" + string(rune('a'+i)),
			Tags: []string{"prod"}, TokenHash: secrets.HashToken(string(rune('a' + i))), TokenPrefix: "mt_live_x"}, plan.MaxServers); err != nil {
			t.Fatalf("create server %d: %v", i, err)
		}
	}
	_, err = st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "over", TokenHash: "h"}, plan.MaxServers)
	if !errors.Is(err, store.ErrLimitReached) {
		t.Fatalf("over-quota create error = %v, want ErrLimitReached", err)
	}

	// Last owner cannot leave or be demoted.
	if err := st.RemoveMember(c, org.ID, u.ID); !errors.Is(err, store.ErrLastOwner) {
		t.Fatalf("remove last owner error = %v", err)
	}
	if _, err := st.UpdateMemberRole(c, org.ID, u.ID, store.RoleAdmin); !errors.Is(err, store.ErrLastOwner) {
		t.Fatalf("demote last owner error = %v", err)
	}
}

func TestInvitesRequireMatchingVerifiedEmail(t *testing.T) {
	st, c := newStore(t), ctx(t)
	owner, _ := st.UpsertUser(c, "uid-owner", "owner@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, owner.ID, "free")
	maxMembers := func(string) int { return 3 }

	inv, err := st.CreateInvite(c, org.ID, owner.ID, "Guest@Example.com", store.RoleMember, secrets.HashToken("tok"), time.Hour, 3)
	if err != nil || inv.Email != "guest@example.com" {
		t.Fatalf("invite = %+v, %v", inv, err)
	}

	stranger, _ := st.UpsertUser(c, "uid-x", "stranger@example.com", "", true)
	if _, err := st.AcceptInvite(c, secrets.HashToken("tok"), stranger, maxMembers); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("stranger accept error = %v", err)
	}
	unverified, _ := st.UpsertUser(c, "uid-g", "guest@example.com", "", false)
	if _, err := st.AcceptInvite(c, secrets.HashToken("tok"), unverified, maxMembers); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("unverified accept error = %v", err)
	}
	guest, _ := st.UpsertUser(c, "uid-g", "guest@example.com", "", true)
	got, err := st.AcceptInvite(c, secrets.HashToken("tok"), guest, maxMembers)
	if err != nil || got.ID != org.ID {
		t.Fatalf("accept = %+v, %v", got, err)
	}
	if role, err := st.GetRole(c, org.ID, guest.ID); err != nil || role != store.RoleMember {
		t.Fatalf("role = %q, %v", role, err)
	}
	if _, err := st.AcceptInvite(c, secrets.HashToken("tok"), guest, maxMembers); !errors.Is(err, store.ErrInviteInvalid) {
		t.Fatalf("reused invite error = %v", err)
	}
}

func TestRollupsIdempotentAndTouch(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "legacy")
	srv, err := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "web", TokenHash: "h1", TokenPrefix: "p"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Truncate(time.Minute).Add(-10 * time.Minute)
	var buckets []metrics.Bucket
	for i := range 5 {
		buckets = append(buckets, metrics.Bucket{ServerID: srv.ID, Res: metrics.Minute, Start: start.Add(time.Duration(i) * time.Minute),
			Samples: 12, CPUAvg: 10, CPUMax: 20, NetInAvg: 1000, MemTotalBytes: 1 << 33})
	}
	buckets = append(buckets,
		metrics.Bucket{ServerID: srv.ID, Res: metrics.Hour, Start: start.Truncate(time.Hour), Samples: 60},
		metrics.Bucket{ServerID: 999_999, Res: metrics.Minute, Start: start, Samples: 1}, // deleted server: dropped
	)
	for range 2 {
		if err := st.WriteBuckets(c, buckets); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	got, err := st.ReadBuckets(c, srv.ID, metrics.Minute, start, start.Add(time.Hour))
	if err != nil || len(got) != 5 || got[0].MemTotalBytes != 1<<33 {
		t.Fatalf("read = %+v, %v", got, err)
	}
	// A bucket written twice (a minute split by a restart) merges: samples
	// add up and weighted averages are preserved.
	if got[0].Samples != 24 || got[0].CPUAvg != 10 || got[0].CPUMax != 20 || got[0].NetInAvg != 1000 {
		t.Fatalf("merged bucket = %+v", got[0])
	}
	up, _ := st.UptimeDays(c, []int64{srv.ID}, start.Add(-24*time.Hour))
	total := 0
	for _, d := range up {
		total += d.MinutesUp
	}
	if total != 5 {
		t.Fatalf("uptime minutes = %d, want 5 (merges must not count as new minutes)", total)
	}

	seen := time.Now().UTC().Truncate(time.Second)
	if err := st.TouchServers(c, []store.ServerTouch{{ID: srv.ID, LastSeen: seen, AgentVersion: "1.2.3"}}); err != nil {
		t.Fatal(err)
	}
	all, _ := st.ListAllServers(c)
	if all[0].LastSeen == nil || !all[0].LastSeen.Equal(seen) || all[0].AgentVersion != "1.2.3" {
		t.Fatalf("touch = %+v", all[0])
	}
	if _, err := st.ApplyRetention(c); err != nil {
		t.Fatalf("retention: %v", err)
	}
}

// TestRollupsExtendedColumns covers the F6 columns of migration 00003:
// round-trip, NULL for buckets without extended samples, and merges
// weighted by ext_samples rather than samples.
func TestRollupsExtendedColumns(t *testing.T) {
	pool := testdb.Migrated(t)
	c := ctx(t)
	box, _ := secrets.NewBox(bytes.Repeat([]byte{1}, 32))
	st := store.New(pool, box)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "legacy")
	srv, err := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "web", TokenHash: "h1", TokenPrefix: "p"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Truncate(time.Minute).Add(-10 * time.Minute)
	at := func(m int) time.Time { return start.Add(time.Duration(m) * time.Minute) }
	ext := func(m, samples, extSamples int, load, swap, read, write float32) metrics.Bucket {
		return metrics.Bucket{ServerID: srv.ID, Res: metrics.Minute, Start: at(m), Samples: samples, CPUAvg: 10,
			ExtSamples: extSamples, Load1Avg: load, Load1Max: load * 2, SwapAvg: swap,
			DiskReadAvg: read, DiskReadMax: read * 2, DiskWriteAvg: write, DiskWriteMax: write * 2}
	}

	// A row as written before migration 00003 (or by any code unaware of
	// the new columns): the columns default to NULL and ext_samples to 0.
	if _, err := pool.Exec(c, `INSERT INTO metrics_1m (server_id, bucket, samples, cpu_avg) VALUES ($1, $2, 6, 10)`, srv.ID, at(3)); err != nil {
		t.Fatal(err)
	}
	writes := [][]metrics.Bucket{
		{
			ext(0, 12, 12, 1.5, 20, 4096, 1024), // F6 agent
			ext(1, 12, 0, 9, 9, 9, 9),           // older agent: values ignored, NULL
			ext(2, 6, 6, 1, 10, 100, 0),         // first half of a restart split
			ext(4, 6, 0, 0, 0, 0, 0),            // both halves without extended samples
		},
		{
			ext(2, 6, 2, 3, 30, 300, 40), // second half: weighted 6:2, not 6:6
			ext(3, 6, 4, 2, 50, 10, 10),  // merged into the pre-00003 row
			ext(4, 6, 0, 0, 0, 0, 0),
		},
	}
	for _, w := range writes {
		if err := st.WriteBuckets(c, w); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	got, err := st.ReadBuckets(c, srv.ID, metrics.Minute, start, at(5))
	if err != nil || len(got) != 5 {
		t.Fatalf("read = %+v, %v", got, err)
	}
	tests := []struct {
		name                    string
		samples, extSamples     int
		load, loadMax, swap     float32
		read, readMax, writeAvg float32
	}{
		{"round trip", 12, 12, 1.5, 3, 20, 4096, 8192, 1024},
		{"older agent reads back as no extended data", 12, 0, 0, 0, 0, 0, 0, 0},
		{"restart split merges by ext_samples", 12, 8, 1.5, 6, 15, 150, 600, 10},
		{"pre-00003 row merges with an F6 write", 12, 4, 2, 4, 50, 10, 20, 10},
		{"no extended samples on either side", 12, 0, 0, 0, 0, 0, 0, 0},
	}
	for i, tc := range tests {
		b := got[i]
		if b.Samples != tc.samples || b.ExtSamples != tc.extSamples || b.Load1Avg != tc.load || b.Load1Max != tc.loadMax ||
			b.SwapAvg != tc.swap || b.DiskReadAvg != tc.read || b.DiskReadMax != tc.readMax || b.DiskWriteAvg != tc.writeAvg {
			t.Errorf("%s: got samples %d ext %d load %v/%v swap %v read %v/%v write %v, want %+v", tc.name,
				b.Samples, b.ExtSamples, b.Load1Avg, b.Load1Max, b.SwapAvg, b.DiskReadAvg, b.DiskReadMax, b.DiskWriteAvg, tc)
		}
	}

	// NULL in SQL, not 0, wherever there were no extended samples.
	var nulls []bool
	rows, err := pool.Query(c, `SELECT load1_avg IS NULL AND load1_max IS NULL AND swap_avg IS NULL AND disk_read_bps_avg IS NULL
		AND disk_read_bps_max IS NULL AND disk_write_bps_avg IS NULL AND disk_write_bps_max IS NULL
		FROM metrics_1m WHERE server_id = $1 ORDER BY bucket`, srv.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var null bool
		if err := rows.Scan(&null); err != nil {
			t.Fatal(err)
		}
		nulls = append(nulls, null)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []bool{false, true, false, false, true}; len(nulls) != len(want) || nulls[0] != want[0] || nulls[1] != want[1] ||
		nulls[2] != want[2] || nulls[3] != want[3] || nulls[4] != want[4] {
		t.Fatalf("all-NULL extended columns per bucket = %v, want %v", nulls, want)
	}

	// Hour rollups carry the same columns.
	hour := metrics.Bucket{ServerID: srv.ID, Res: metrics.Hour, Start: start.Truncate(time.Hour), Samples: 720,
		ExtSamples: 360, Load1Avg: 0.5, Load1Max: 4, SwapAvg: 1, DiskReadAvg: 2, DiskReadMax: 3, DiskWriteAvg: 4, DiskWriteMax: 5}
	if err := st.WriteBuckets(c, []metrics.Bucket{hour}); err != nil {
		t.Fatal(err)
	}
	hours, err := st.ReadBuckets(c, srv.ID, metrics.Hour, hour.Start, hour.Start.Add(time.Hour))
	if err != nil || len(hours) != 1 {
		t.Fatalf("hours = %+v, %v", hours, err)
	}
	if h := hours[0]; h.ExtSamples != 360 || h.Load1Avg != 0.5 || h.Load1Max != 4 || h.DiskWriteMax != 5 {
		t.Fatalf("hour = %+v", h)
	}

	// The widened CHECK accepts rules on the new metrics.
	if _, err := st.CreateRules(c, org.ID, []store.Rule{
		{Name: "load", Enabled: true, ScopeAll: true, Metric: "load1", Comparison: "above", Threshold: 4, Severity: "warning"},
		{Name: "swap", Enabled: true, ScopeAll: true, Metric: "swap", Comparison: "above", Threshold: 80, Severity: "warning"},
	}, 0); err != nil {
		t.Fatalf("create load1/swap rules: %v", err)
	}
	if _, err := st.CreateRules(c, org.ID, []store.Rule{
		{Name: "bogus", Enabled: true, ScopeAll: true, Metric: "load5", Comparison: "above", Threshold: 4, Severity: "warning"},
	}, 0); err == nil {
		t.Fatal("rule on an unknown metric accepted by the CHECK")
	}
}

func TestChannelsEncryptedAndRulesCleanup(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")

	const secret = "https://hooks.slack.com/services/T000/B000/SECRET"
	ch, err := st.CreateChannel(c, org.ID, "slack", "ops", true, []byte(`{"webhook_url":"`+secret+`"}`), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(ch.Config, []byte(secret)) {
		t.Fatalf("decrypted config = %s", ch.Config)
	}
	rules, err := st.CreateRules(c, org.ID, []store.Rule{{Name: "cpu", Enabled: true, ScopeAll: true, Metric: "cpu",
		Comparison: "above", Threshold: 80, Severity: "warning", ChannelIDs: []int64{ch.ID}}}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteChannel(c, org.ID, ch.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := st.GetRule(c, org.ID, rules[0].ID)
	if len(after.ChannelIDs) != 0 {
		t.Fatalf("rule still routes to deleted channel: %v", after.ChannelIDs)
	}
}

func TestChannelConfigNotPlaintextAtRest(t *testing.T) {
	pool := testdb.Migrated(t)
	c := ctx(t)
	box, _ := secrets.NewBox(bytes.Repeat([]byte{1}, 32))
	st := store.New(pool, box)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	if _, err := st.CreateChannel(c, org.ID, "telegram", "tg", true, []byte(`{"telegram_token":"123:SECRETSECRET"}`), 0); err != nil {
		t.Fatal(err)
	}
	var sealed []byte
	if err := pool.QueryRow(c, `SELECT config_enc FROM notification_channels`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("SECRETSECRET")) {
		t.Fatal("channel secret stored in plaintext")
	}
}

func TestIncidentsLifecycle(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "Ana", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	srv, _ := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "db", TokenHash: "h"}, 0)

	id, err := st.OpenIncident(c, store.NewIncident{OrgID: org.ID, ServerID: srv.ID, RuleName: "disk", Metric: "disk",
		Severity: "critical", Threshold: 90, Peak: 93, LastValue: 93, SamplesOver: 1, StartedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveIncidentProgress(c, id, 95, 94, 12, nil); err != nil {
		t.Fatal(err)
	}
	inc, err := st.AckIncident(c, org.ID, id, u.ID, time.Now())
	if err != nil || inc.State() != "acked" || inc.AckedBy == nil || *inc.AckedBy != "Ana" || inc.Peak != 95 {
		t.Fatalf("ack = %+v, %v", inc, err)
	}
	if err := st.AppendNotified(c, id, []string{"email", "slack"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	list, counts, err := st.ListIncidents(c, org.ID, store.IncidentFilter{State: "acked"})
	if err != nil || len(list) != 1 || counts.Acked != 1 || len(list[0].NotifiedChannels) != 2 {
		t.Fatalf("list = %+v counts %+v, %v", list, counts, err)
	}
	if err := st.ResolveIncident(c, id, time.Now(), "manual", 95, 12, &u.ID); err != nil {
		t.Fatal(err)
	}
	open, _ := st.LoadOpenIncidents(c)
	if len(open) != 0 {
		t.Fatalf("open after resolve = %d", len(open))
	}
	if _, err := st.AckIncident(c, org.ID, id, u.ID, time.Now()); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("ack resolved error = %v", err)
	}

	// Other tenants cannot see it.
	other, _ := st.UpsertUser(c, "uid-2", "two@example.com", "", true)
	otherOrg, _ := st.EnsurePersonalOrg(c, other.ID, "free")
	if _, err := st.GetIncident(c, otherOrg.ID, id); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant incident read error = %v", err)
	}
}

func TestDeleteUserRemovesSoleOwnedOrgs(t *testing.T) {
	st, c := newStore(t), ctx(t)
	u, _ := st.UpsertUser(c, "uid-1", "one@example.com", "", true)
	org, _ := st.EnsurePersonalOrg(c, u.ID, "free")
	srv, _ := st.CreateServer(c, store.NewServer{OrgID: org.ID, Name: "x", TokenHash: "h"}, 0)
	deleted, err := st.DeleteUser(c, u.ID)
	if err != nil || len(deleted) != 1 || deleted[0].OrgID != org.ID || len(deleted[0].ServerIDs) != 1 || deleted[0].ServerIDs[0] != srv.ID {
		t.Fatalf("deleted = %+v, %v", deleted, err)
	}
	if all, _ := st.ListAllServers(c); len(all) != 0 {
		t.Fatalf("servers left = %d", len(all))
	}
}
