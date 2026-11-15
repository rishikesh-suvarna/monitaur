package app

import (
	"context"
	"slices"
	"strings"
	"time"

	"backend/store"
)

// silenced reports whether an active maintenance window of the org covers the
// server or the check at the given time (F11, docs/platform-v2.md 6.4). It
// reads only the directory, so it is safe on every alert event and every live
// snapshot. Pass 0 for the ID that does not apply.
func (a *App) silenced(orgID, serverID, checkID int64, at time.Time) bool {
	if serverID <= 0 && checkID <= 0 {
		return false
	}
	windows := a.dir.OrgMaintenance(orgID)
	if len(windows) == 0 {
		return false // the common case: no tag lookup, no allocation
	}
	var tags []string
	if serverID > 0 {
		if s, ok := a.dir.OrgServer(orgID, serverID); ok {
			tags = s.Tags
		}
	}
	for _, w := range windows {
		if w.ActiveAt(at) && windowCovers(w, serverID, tags, checkID) {
			return true
		}
	}
	return false
}

// windowCovers applies a window's scope the way alerting.Rule.Matches applies
// a rule's: all, a listed server ID, or any shared tag (case-insensitive); and
// for checks, a listed check ID.
func windowCovers(w store.MaintenanceWindow, serverID int64, serverTags []string, checkID int64) bool {
	if w.ScopeAll {
		return true
	}
	if serverID > 0 {
		if slices.Contains(w.ScopeServerIDs, serverID) {
			return true
		}
		for _, want := range w.ScopeTags {
			if slices.ContainsFunc(serverTags, func(have string) bool { return strings.EqualFold(want, have) }) {
				return true
			}
		}
	}
	return checkID > 0 && slices.Contains(w.ScopeCheckIDs, checkID)
}

// markSilenced flags a silenced incident off the engine's call path, like
// AppendNotified: one short write per silenced EventFired.
func (a *App) markSilenced(incidentID int64) {
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, notifyWriteTimeout)
		defer cancel()
		if err := a.store.MarkIncidentSilenced(ctx, incidentID); err != nil {
			a.log.Warn("mark incident silenced", "incident_id", incidentID, "err", err)
		}
	}()
}
