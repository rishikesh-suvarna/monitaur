package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Channel holds the decrypted config JSON. Config never leaves the backend:
// the API returns a redacted summary instead.
type Channel struct {
	ID             int64
	OrgID          int64
	Type           string
	Name           string
	Enabled        bool
	Config         []byte
	LastDeliveryAt *time.Time
	LastDeliveryOK *bool
	LastError      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const (
	channelColumns = `id, org_id, type, name, enabled, config_enc, last_delivery_at, last_delivery_ok, last_error, created_at, updated_at`
	maxErrorLen    = 300
)

func (s *Store) scanChannel(row pgx.Row) (Channel, error) {
	var (
		c      Channel
		sealed []byte
	)
	if err := row.Scan(&c.ID, &c.OrgID, &c.Type, &c.Name, &c.Enabled, &sealed, &c.LastDeliveryAt, &c.LastDeliveryOK,
		&c.LastError, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return c, mapErr(err)
	}
	cfg, err := s.box.Open(sealed)
	if err != nil {
		return c, fmt.Errorf("decrypt channel %d: %w", c.ID, err)
	}
	c.Config = cfg
	return c, nil
}

func (s *Store) collectChannels(rows pgx.Rows, err error) ([]Channel, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		c, err := s.scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListAllChannels(ctx context.Context) ([]Channel, error) {
	return s.collectChannels(s.pool.Query(ctx, `SELECT `+channelColumns+` FROM notification_channels ORDER BY org_id, id`))
}

func (s *Store) ListOrgChannels(ctx context.Context, orgID int64) ([]Channel, error) {
	return s.collectChannels(s.pool.Query(ctx, `SELECT `+channelColumns+` FROM notification_channels WHERE org_id = $1 ORDER BY id`, orgID))
}

func (s *Store) GetChannel(ctx context.Context, orgID, id int64) (Channel, error) {
	return s.scanChannel(s.pool.QueryRow(ctx, `SELECT `+channelColumns+` FROM notification_channels WHERE org_id = $1 AND id = $2`, orgID, id))
}

func (s *Store) CreateChannel(ctx context.Context, orgID int64, typ, name string, enabled bool, config []byte, maxChannels int) (Channel, error) {
	sealed, err := s.box.Seal(config)
	if err != nil {
		return Channel{}, err
	}
	var ch Channel
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, orgID); err != nil {
			return err
		}
		if !unlimited(maxChannels) {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM notification_channels WHERE org_id = $1`, orgID).Scan(&n); err != nil {
				return err
			}
			if n >= maxChannels {
				return ErrLimitReached
			}
		}
		var err error
		ch, err = s.scanChannel(tx.QueryRow(ctx, `
INSERT INTO notification_channels (org_id, type, name, enabled, config_enc) VALUES ($1, $2, $3, $4, $5)
RETURNING `+channelColumns, orgID, typ, name, enabled, sealed))
		return err
	})
	return ch, err
}

// UpdateChannel changes the given fields; config nil leaves it untouched.
func (s *Store) UpdateChannel(ctx context.Context, orgID, id int64, name *string, enabled *bool, config []byte) (Channel, error) {
	var sealed []byte
	if config != nil {
		var err error
		if sealed, err = s.box.Seal(config); err != nil {
			return Channel{}, err
		}
	}
	return s.scanChannel(s.pool.QueryRow(ctx, `
UPDATE notification_channels SET
	name = COALESCE($3, name),
	enabled = COALESCE($4, enabled),
	config_enc = COALESCE($5, config_enc),
	updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING `+channelColumns, orgID, id, name, enabled, sealed))
}

// DeleteChannel also removes the channel from every rule that routed to it.
func (s *Store) DeleteChannel(ctx context.Context, orgID, id int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM notification_channels WHERE org_id = $1 AND id = $2`, orgID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `
UPDATE alert_rules SET channel_ids = array_remove(channel_ids, $2), updated_at = now()
WHERE org_id = $1 AND $2 = ANY(channel_ids)`, orgID, id)
		return err
	})
}

// RecordDelivery implements notify.DeliveryRecorder. Deliveries only happen on
// incident transitions, so this write is rare.
func (s *Store) RecordDelivery(ctx context.Context, channelID int64, at time.Time, deliveryErr error) {
	msg := ""
	if deliveryErr != nil {
		msg = truncate(deliveryErr.Error(), maxErrorLen)
	}
	_, _ = s.pool.Exec(ctx, `
UPDATE notification_channels SET last_delivery_at = $2, last_delivery_ok = $3, last_error = $4 WHERE id = $1`,
		channelID, at, deliveryErr == nil, msg)
}
