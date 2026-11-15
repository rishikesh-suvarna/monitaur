package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxMaintenanceWindows is a sanity cap per org, not a plan limit: windows
// are cached in memory and scanned on every alert event, so an org cannot
// grow the list without bound. Ended windows count until deleted.
const MaxMaintenanceWindows = 100

// Maintenance window states (GET /maintenance `state`).
const (
	MaintenanceScheduled = "scheduled"
	MaintenanceActive    = "active"
	MaintenanceEnded     = "ended"
)

// MaintenanceWindow silences notifications for its scope between StartsAt
// (inclusive) and EndsAt (exclusive).
type MaintenanceWindow struct {
	ID             int64
	OrgID          int64
	Name           string
	ScopeAll       bool
	ScopeServerIDs []int64
	ScopeTags      []string
	ScopeCheckIDs  []int64
	StartsAt       time.Time
	EndsAt         time.Time
	CreatedByID    *int64
	CreatedBy      *string // display name, else email; nil once the user is deleted
	CreatedAt      time.Time
}

// ActiveAt reports whether at falls inside [StartsAt, EndsAt).
func (w MaintenanceWindow) ActiveAt(at time.Time) bool {
	return !at.Before(w.StartsAt) && at.Before(w.EndsAt)
}

func (w MaintenanceWindow) State(now time.Time) string {
	switch {
	case now.Before(w.StartsAt):
		return MaintenanceScheduled
	case now.Before(w.EndsAt):
		return MaintenanceActive
	default:
		return MaintenanceEnded
	}
}

func (w *MaintenanceWindow) normalize() {
	if w.ScopeServerIDs == nil {
		w.ScopeServerIDs = []int64{}
	}
	if w.ScopeTags == nil {
		w.ScopeTags = []string{}
	}
	if w.ScopeCheckIDs == nil {
		w.ScopeCheckIDs = []int64{}
	}
}

// maintenanceColumns reads windows with their creator's name; callers append
// WHERE/ORDER clauses to maintenanceFrom.
const maintenanceColumns = `w.id, w.org_id, w.name, w.scope_all, w.scope_server_ids, w.scope_tags, w.scope_check_ids,
	w.starts_at, w.ends_at, w.created_by, NULLIF(COALESCE(NULLIF(u.display_name, ''), u.email), ''), w.created_at`

const maintenanceFrom = ` FROM maintenance_windows w LEFT JOIN users u ON u.id = w.created_by `

// maintenanceReturning wraps a write that returns maintenance_windows rows
// (as CTE w) so the result carries the creator's name like a read does.
func maintenanceReturning(write string) string {
	return `WITH w AS (` + write + ` RETURNING *) SELECT ` + maintenanceColumns + ` FROM w LEFT JOIN users u ON u.id = w.created_by`
}

func scanMaintenance(row pgx.Row) (MaintenanceWindow, error) {
	var w MaintenanceWindow
	err := row.Scan(&w.ID, &w.OrgID, &w.Name, &w.ScopeAll, &w.ScopeServerIDs, &w.ScopeTags, &w.ScopeCheckIDs,
		&w.StartsAt, &w.EndsAt, &w.CreatedByID, &w.CreatedBy, &w.CreatedAt)
	w.normalize()
	return w, mapErr(err)
}

func collectMaintenance(rows pgx.Rows, err error) ([]MaintenanceWindow, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MaintenanceWindow
	for rows.Next() {
		w, err := scanMaintenance(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// ListAllMaintenanceWindows loads the directory at startup (one query).
func (s *Store) ListAllMaintenanceWindows(ctx context.Context) ([]MaintenanceWindow, error) {
	return collectMaintenance(s.pool.Query(ctx, `SELECT `+maintenanceColumns+maintenanceFrom+`ORDER BY w.org_id, w.id`))
}

func (s *Store) ListOrgMaintenanceWindows(ctx context.Context, orgID int64) ([]MaintenanceWindow, error) {
	return collectMaintenance(s.pool.Query(ctx, `SELECT `+maintenanceColumns+maintenanceFrom+`WHERE w.org_id = $1 ORDER BY w.id`, orgID))
}

func (s *Store) GetMaintenanceWindow(ctx context.Context, orgID, id int64) (MaintenanceWindow, error) {
	return scanMaintenance(s.pool.QueryRow(ctx, `SELECT `+maintenanceColumns+maintenanceFrom+`WHERE w.org_id = $1 AND w.id = $2`, orgID, id))
}

// CreateMaintenanceWindow locks the org row so concurrent creates cannot pass
// maxWindows (0 = unlimited).
func (s *Store) CreateMaintenanceWindow(ctx context.Context, w MaintenanceWindow, maxWindows int) (MaintenanceWindow, error) {
	w.normalize()
	var created MaintenanceWindow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, w.OrgID); err != nil {
			return err
		}
		if !unlimited(maxWindows) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM maintenance_windows WHERE org_id = $1`, w.OrgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxWindows {
				return ErrLimitReached
			}
		}
		var err error
		created, err = scanMaintenance(tx.QueryRow(ctx, maintenanceReturning(`
INSERT INTO maintenance_windows (org_id, name, scope_all, scope_server_ids, scope_tags, scope_check_ids, starts_at, ends_at, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`),
			w.OrgID, w.Name, w.ScopeAll, w.ScopeServerIDs, w.ScopeTags, w.ScopeCheckIDs, w.StartsAt, w.EndsAt, w.CreatedByID))
		return err
	})
	return created, err
}

// UpdateMaintenanceWindow replaces every editable field (the API merges
// partial updates before calling). Another org's window is ErrNotFound.
func (s *Store) UpdateMaintenanceWindow(ctx context.Context, w MaintenanceWindow) (MaintenanceWindow, error) {
	w.normalize()
	return scanMaintenance(s.pool.QueryRow(ctx, maintenanceReturning(`
UPDATE maintenance_windows SET name = $3, scope_all = $4, scope_server_ids = $5, scope_tags = $6, scope_check_ids = $7,
	starts_at = $8, ends_at = $9
WHERE org_id = $1 AND id = $2`),
		w.OrgID, w.ID, w.Name, w.ScopeAll, w.ScopeServerIDs, w.ScopeTags, w.ScopeCheckIDs, w.StartsAt, w.EndsAt))
}

func (s *Store) DeleteMaintenanceWindow(ctx context.Context, orgID, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM maintenance_windows WHERE org_id = $1 AND id = $2`, orgID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkIncidentSilenced records that an incident opened during a maintenance
// window. It runs once per silenced EventFired, never per sample.
func (s *Store) MarkIncidentSilenced(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE incidents SET silenced = true WHERE id = $1`, id)
	return err
}
