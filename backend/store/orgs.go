package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type User struct {
	ID            int64     `json:"id"`
	FirebaseUID   string    `json:"-"`
	Email         string    `json:"email"`
	DisplayName   string    `json:"display_name"`
	EmailVerified bool      `json:"email_verified"`
	CreatedAt     time.Time `json:"created_at"`
}

type Plan struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	MaxServers         int    `json:"max_servers"`
	MinIntervalSeconds int    `json:"min_interval_seconds"`
	Retention1mDays    int    `json:"retention_1m_days"`
	Retention1hDays    int    `json:"retention_1h_days"`
	MaxMembers         int    `json:"max_members"`
	AlertEmailsPerDay  int    `json:"alert_emails_per_day"`
	MaxRules           int    `json:"max_rules"`
	MaxChannels        int    `json:"max_channels"`
	APIRPM             int    `json:"api_rpm"`
}

func (p Plan) MinInterval() time.Duration { return time.Duration(p.MinIntervalSeconds) * time.Second }

type StatusPage struct {
	Enabled   bool    `json:"enabled"`
	Title     string  `json:"title"`
	ServerIDs []int64 `json:"server_ids"`
}

type Org struct {
	ID              int64      `json:"id"`
	Name            string     `json:"name"`
	Slug            string     `json:"slug"`
	PlanID          string     `json:"plan_id"`
	PersonalOwnerID *int64     `json:"-"`
	DefaultsSeeded  bool       `json:"-"`
	StatusPage      StatusPage `json:"status_page"`
	CreatedAt       time.Time  `json:"created_at"`
}

func (o Org) Personal() bool { return o.PersonalOwnerID != nil }

type OrgMembership struct {
	Org
	Role Role `json:"role"`
}

type Member struct {
	UserID      int64     `json:"user_id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
	JoinedAt    time.Time `json:"joined_at"`
}

type Invite struct {
	ID        int64     `json:"id"`
	OrgID     int64     `json:"-"`
	Email     string    `json:"email"`
	Role      Role      `json:"role"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type Usage struct {
	Servers  int `json:"servers"`
	Members  int `json:"members"`
	Rules    int `json:"rules"`
	Channels int `json:"channels"`
}

const (
	userColumns = `id, firebase_uid, email, display_name, email_verified, created_at`
	orgColumns  = `o.id, o.name, o.slug, o.plan_id, o.personal_owner_id, o.defaults_seeded,
		o.status_page_enabled, o.status_page_title, o.status_page_server_ids, o.created_at`
	planColumns = `id, name, max_servers, min_interval_seconds, retention_1m_days, retention_1h_days,
		max_members, alert_emails_per_day, max_rules, max_channels, api_rpm`
	slugRandomBytes   = 4
	personalOrgName   = "Personal"
	maxDisplayNameLen = 80
)

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.FirebaseUID, &u.Email, &u.DisplayName, &u.EmailVerified, &u.CreatedAt)
	return u, mapErr(err)
}

func scanOrg(row pgx.Row, extra ...any) (Org, error) {
	var o Org
	dest := append([]any{&o.ID, &o.Name, &o.Slug, &o.PlanID, &o.PersonalOwnerID, &o.DefaultsSeeded,
		&o.StatusPage.Enabled, &o.StatusPage.Title, &o.StatusPage.ServerIDs, &o.CreatedAt}, extra...)
	err := row.Scan(dest...)
	return o, mapErr(err)
}

// UpsertUser creates the user on first sign-in and refreshes email and
// verification state from the Firebase token when they change.
func (s *Store) UpsertUser(ctx context.Context, uid, email, displayName string, verified bool) (User, error) {
	displayName = truncate(displayName, maxDisplayNameLen)
	const q = `
WITH up AS (
	INSERT INTO users (firebase_uid, email, display_name, email_verified, created_at, updated_at)
	VALUES ($1, $2, $3, $4, now(), now())
	ON CONFLICT (firebase_uid) DO UPDATE
	SET email = EXCLUDED.email,
	    email_verified = EXCLUDED.email_verified,
	    display_name = CASE WHEN users.display_name = '' THEN EXCLUDED.display_name ELSE users.display_name END,
	    updated_at = now()
	WHERE users.email IS DISTINCT FROM EXCLUDED.email
	   OR users.email_verified IS DISTINCT FROM EXCLUDED.email_verified
	   OR (users.display_name = '' AND EXCLUDED.display_name <> '')
	RETURNING ` + userColumns + `
)
SELECT ` + userColumns + ` FROM up
UNION ALL
SELECT ` + userColumns + ` FROM users WHERE firebase_uid = $1 AND NOT EXISTS (SELECT 1 FROM up)`
	return scanUser(s.pool.QueryRow(ctx, q, uid, email, displayName, verified))
}

func (s *Store) GetUser(ctx context.Context, id int64) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
}

func (s *Store) UpdateDisplayName(ctx context.Context, id int64, name string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING `+userColumns,
		id, truncate(strings.TrimSpace(name), maxDisplayNameLen)))
}

// EnsurePersonalOrg returns the user's personal org, creating it (with an
// owner membership) on first sign-in.
func (s *Store) EnsurePersonalOrg(ctx context.Context, userID int64, planID string) (Org, error) {
	var org Org
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		org, err = scanOrg(tx.QueryRow(ctx, `SELECT `+orgColumns+` FROM organizations o WHERE o.personal_owner_id = $1`, userID))
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		slug, err := newSlug(userID)
		if err != nil {
			return err
		}
		org, err = scanOrg(tx.QueryRow(ctx, `
INSERT INTO organizations AS o (name, slug, plan_id, personal_owner_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (personal_owner_id) DO UPDATE SET name = o.name
RETURNING `+orgColumns, personalOrgName, slug, planID, userID))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, org.ID, userID)
		return err
	})
	return org, err
}

func newSlug(userID int64) (string, error) {
	buf := make([]byte, slugRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("u%d-%s", userID, hex.EncodeToString(buf)), nil
}

func (s *Store) ListUserOrgs(ctx context.Context, userID int64) ([]OrgMembership, error) {
	rows, err := s.pool.Query(ctx, `
SELECT `+orgColumns+`, m.role
FROM memberships m JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1
ORDER BY (o.personal_owner_id = $1) DESC NULLS LAST, o.name, o.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OrgMembership
	for rows.Next() {
		var m OrgMembership
		org, err := scanOrg(rows, &m.Role)
		if err != nil {
			return nil, err
		}
		m.Org = org
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetRole(ctx context.Context, orgID, userID int64) (Role, error) {
	var r Role
	err := s.pool.QueryRow(ctx, `SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2`, orgID, userID).Scan(&r)
	return r, mapErr(err)
}

func (s *Store) GetOrg(ctx context.Context, id int64) (Org, error) {
	return scanOrg(s.pool.QueryRow(ctx, `SELECT `+orgColumns+` FROM organizations o WHERE o.id = $1`, id))
}

func (s *Store) OrgBySlug(ctx context.Context, slug string) (Org, error) {
	return scanOrg(s.pool.QueryRow(ctx, `SELECT `+orgColumns+` FROM organizations o WHERE o.slug = $1`, slug))
}

type OrgPatch struct {
	Name       *string
	Slug       *string
	StatusPage *StatusPage
}

func (s *Store) UpdateOrg(ctx context.Context, id int64, p OrgPatch) (Org, error) {
	var (
		spEnabled *bool
		spTitle   *string
		spServers []int64
		spSet     bool
	)
	if p.StatusPage != nil {
		spEnabled, spTitle, spServers, spSet = &p.StatusPage.Enabled, &p.StatusPage.Title, p.StatusPage.ServerIDs, true
		if spServers == nil {
			spServers = []int64{}
		}
	}
	return scanOrg(s.pool.QueryRow(ctx, `
UPDATE organizations o SET
	name = COALESCE($2, o.name),
	slug = COALESCE($3, o.slug),
	status_page_enabled = COALESCE($4, o.status_page_enabled),
	status_page_title = COALESCE($5, o.status_page_title),
	status_page_server_ids = CASE WHEN $7 THEN
		ARRAY(SELECT s.id FROM servers s WHERE s.org_id = o.id AND s.id = ANY($6::bigint[]) ORDER BY s.name)
		ELSE o.status_page_server_ids END
WHERE o.id = $1
RETURNING `+orgColumns, id, p.Name, p.Slug, spEnabled, spTitle, spServers, spSet))
}

func (s *Store) GetPlan(ctx context.Context, id string) (Plan, error) {
	var p Plan
	err := s.pool.QueryRow(ctx, `SELECT `+planColumns+` FROM plans WHERE id = $1`, id).Scan(
		&p.ID, &p.Name, &p.MaxServers, &p.MinIntervalSeconds, &p.Retention1mDays, &p.Retention1hDays,
		&p.MaxMembers, &p.AlertEmailsPerDay, &p.MaxRules, &p.MaxChannels, &p.APIRPM)
	return p, mapErr(err)
}

func (s *Store) ListPlans(ctx context.Context) ([]Plan, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+planColumns+` FROM plans ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Plan
	for rows.Next() {
		var p Plan
		if err := rows.Scan(&p.ID, &p.Name, &p.MaxServers, &p.MinIntervalSeconds, &p.Retention1mDays, &p.Retention1hDays,
			&p.MaxMembers, &p.AlertEmailsPerDay, &p.MaxRules, &p.MaxChannels, &p.APIRPM); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListAllOrgs feeds the startup cache (org -> plan).
func (s *Store) ListAllOrgs(ctx context.Context) ([]Org, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+orgColumns+` FROM organizations o ORDER BY o.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Org
	for rows.Next() {
		o, err := scanOrg(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// OwnerEmail is used to seed the default email channel of an org.
func (s *Store) OwnerEmail(ctx context.Context, orgID int64) (string, error) {
	var email string
	err := s.pool.QueryRow(ctx, `
SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
WHERE m.org_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`, orgID).Scan(&email)
	return email, mapErr(err)
}

func (s *Store) MarkDefaultsSeeded(ctx context.Context, orgID int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE organizations SET defaults_seeded = true WHERE id = $1`, orgID)
	return err
}

func (s *Store) Usage(ctx context.Context, orgID int64) (Usage, error) {
	var u Usage
	err := s.pool.QueryRow(ctx, `
SELECT (SELECT count(*) FROM servers WHERE org_id = $1),
       (SELECT count(*) FROM memberships WHERE org_id = $1),
       (SELECT count(*) FROM alert_rules WHERE org_id = $1),
       (SELECT count(*) FROM notification_channels WHERE org_id = $1)`, orgID).
		Scan(&u.Servers, &u.Members, &u.Rules, &u.Channels)
	return u, err
}

func (s *Store) ListMembers(ctx context.Context, orgID int64) ([]Member, []Invite, error) {
	rows, err := s.pool.Query(ctx, `
SELECT u.id, u.email, u.display_name, m.role, m.created_at
FROM memberships m JOIN users u ON u.id = m.user_id
WHERE m.org_id = $1 ORDER BY m.created_at`, orgID)
	if err != nil {
		return nil, nil, err
	}
	var members []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Email, &m.DisplayName, &m.Role, &m.JoinedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		members = append(members, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	rows, err = s.pool.Query(ctx, `
SELECT id, org_id, email, role, expires_at, created_at FROM invites
WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at`, orgID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var i Invite
		if err := rows.Scan(&i.ID, &i.OrgID, &i.Email, &i.Role, &i.ExpiresAt, &i.CreatedAt); err != nil {
			return nil, nil, err
		}
		invites = append(invites, i)
	}
	return members, invites, rows.Err()
}

// CreateInvite enforces the member limit counting pending invites, so an org
// cannot over-invite and accept later.
func (s *Store) CreateInvite(ctx context.Context, orgID, invitedBy int64, email string, role Role, tokenHash string, ttl time.Duration, maxMembers int) (Invite, error) {
	var inv Invite
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, orgID); err != nil {
			return err
		}
		// Expired invites must not block a new one for the same email.
		if _, err := tx.Exec(ctx, `DELETE FROM invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at <= now()`, orgID); err != nil {
			return err
		}
		if !unlimited(maxMembers) {
			var n int
			if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM memberships WHERE org_id = $1) +
       (SELECT count(*) FROM invites WHERE org_id = $1 AND accepted_at IS NULL)`, orgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxMembers {
				return ErrLimitReached
			}
		}
		err := tx.QueryRow(ctx, `
INSERT INTO invites (org_id, email, role, token_hash, invited_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, org_id, email, role, expires_at, created_at`,
			orgID, strings.ToLower(strings.TrimSpace(email)), role, tokenHash, invitedBy, time.Now().Add(ttl)).
			Scan(&inv.ID, &inv.OrgID, &inv.Email, &inv.Role, &inv.ExpiresAt, &inv.CreatedAt)
		return mapErr(err)
	})
	return inv, err
}

func (s *Store) DeleteInvite(ctx context.Context, orgID, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM invites WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL`, orgID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AcceptInvite adds the user to the org. The invite must match the user's
// (verified) email so a leaked link cannot be used by someone else.
func (s *Store) AcceptInvite(ctx context.Context, tokenHash string, user User, maxMembersFor func(planID string) int) (Org, error) {
	var org Org
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var (
			inviteID int64
			orgID    int64
			email    string
			role     Role
		)
		err := tx.QueryRow(ctx, `
SELECT id, org_id, email, role FROM invites
WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
FOR UPDATE`, tokenHash).Scan(&inviteID, &orgID, &email, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInviteInvalid
		}
		if err != nil {
			return err
		}
		if !strings.EqualFold(email, user.Email) || !user.EmailVerified {
			return ErrInviteInvalid
		}
		org, err = scanOrg(tx.QueryRow(ctx, `SELECT `+orgColumns+` FROM organizations o WHERE o.id = $1 FOR UPDATE`, orgID))
		if err != nil {
			return err
		}
		// Pending invites were counted at invite time, so only memberships
		// matter here.
		if maxMembers := maxMembersFor(org.PlanID); !unlimited(maxMembers) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1`, orgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxMembers {
				return ErrLimitReached
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, orgID, user.ID, role); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE invites SET accepted_at = now() WHERE id = $1`, inviteID)
		return err
	})
	return org, err
}

func (s *Store) UpdateMemberRole(ctx context.Context, orgID, userID int64, role Role) (Member, error) {
	var m Member
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := guardLastOwner(ctx, tx, orgID, userID, role); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `
UPDATE memberships m SET role = $3 FROM users u
WHERE m.org_id = $1 AND m.user_id = $2 AND u.id = m.user_id
RETURNING u.id, u.email, u.display_name, m.role, m.created_at`, orgID, userID, role).
			Scan(&m.UserID, &m.Email, &m.DisplayName, &m.Role, &m.JoinedAt)
		return mapErr(err)
	})
	return m, err
}

func (s *Store) RemoveMember(ctx context.Context, orgID, userID int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := guardLastOwner(ctx, tx, orgID, userID, ""); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM memberships WHERE org_id = $1 AND user_id = $2`, orgID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// guardLastOwner fails when the change would leave the org without an owner.
// newRole "" means the member is being removed.
func guardLastOwner(ctx context.Context, tx pgx.Tx, orgID, userID int64, newRole Role) error {
	var current Role
	err := tx.QueryRow(ctx, `SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE`, orgID, userID).Scan(&current)
	if err != nil {
		return mapErr(err)
	}
	if current != RoleOwner || newRole == RoleOwner {
		return nil
	}
	var owners int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND role = 'owner'`, orgID).Scan(&owners); err != nil {
		return err
	}
	if owners <= 1 {
		return ErrLastOwner
	}
	return nil
}

// DeletedOrg describes an org removed with its last owner, so callers can
// purge caches and disconnect agents.
type DeletedOrg struct {
	OrgID     int64
	ServerIDs []int64
}

// DeleteUser removes the user, plus every org where they are the only owner
// (cascading servers, metrics, incidents, rules and channels).
func (s *Store) DeleteUser(ctx context.Context, userID int64) ([]DeletedOrg, error) {
	var deleted []DeletedOrg
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
SELECT m.org_id,
       COALESCE((SELECT array_agg(s.id) FROM servers s WHERE s.org_id = m.org_id), '{}')
FROM memberships m
WHERE m.user_id = $1 AND m.role = 'owner'
  AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.org_id = m.org_id AND o.role = 'owner' AND o.user_id <> $1)`, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d DeletedOrg
			if err := rows.Scan(&d.OrgID, &d.ServerIDs); err != nil {
				rows.Close()
				return err
			}
			deleted = append(deleted, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, d := range deleted {
			if _, err := tx.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, d.OrgID); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
	return deleted, err
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
