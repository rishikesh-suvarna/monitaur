package alerting

import (
	"context"
	"errors"
	"time"
)

// Incident is one firing period of a rule on a server.
type Incident struct {
	ID             int64
	OrgID          int64
	ServerID       int64
	RuleID         int64
	RuleName       string
	Metric         Metric
	Severity       Severity
	Threshold      float64
	Peak           float64
	LastValue      float64
	SamplesOver    int
	StartedAt      time.Time
	LastNotifiedAt *time.Time
	AckedAt        *time.Time
}

// ResolveHow records why an incident was closed.
type ResolveHow string

const (
	ResolvedAuto          ResolveHow = "auto"
	ResolvedManual        ResolveHow = "manual"
	ResolvedServerDeleted ResolveHow = "server_deleted"
	ResolvedRuleDeleted   ResolveHow = "rule_changed"
)

// notifies reports whether closing an incident this way emits EventResolved.
// Rule and server removals do not: the condition never cleared, so a
// "resolved" message to the rule's channels would be misleading, and the
// Event carries no ResolveHow a notifier could use to tell them apart.
func (h ResolveHow) notifies() bool {
	return h == ResolvedAuto || h == ResolvedManual
}

// IncidentStore persists incidents. The engine calls OpenIncident and
// ResolveIncident only on state transitions, SaveProgress from the flush
// window, and LoadOpenIncidents once at startup.
type IncidentStore interface {
	OpenIncident(ctx context.Context, inc Incident) (int64, error)
	ResolveIncident(ctx context.Context, id int64, at time.Time, how ResolveHow, peak float64, samplesOver int) error
	// SaveProgress can race with ResolveIncident for the same incident (the
	// flush window and a live transition run on different goroutines), so
	// implementations should only update incidents that are still open.
	SaveProgress(ctx context.Context, id int64, peak, lastValue float64, samplesOver int, lastNotifiedAt *time.Time) error
	LoadOpenIncidents(ctx context.Context) ([]Incident, error)
}

// EventKind says what happened to an incident.
type EventKind string

const (
	EventFired    EventKind = "fired"
	EventRenotify EventKind = "renotify"
	EventResolved EventKind = "resolved"
)

// Event is handed to the Notifier after the matching store write succeeded.
type Event struct {
	Kind     EventKind
	Incident Incident
	Rule     Rule
	Server   ServerInfo
	At       time.Time
}

// Notifier delivers events. Notify must not block: the engine calls it on
// the agent ingest path.
type Notifier interface {
	Notify(ctx context.Context, ev Event)
}

// ErrIncidentNotFound is returned by Engine.Resolve for an incident the
// engine does not hold open (already resolved, or never opened).
var ErrIncidentNotFound = errors.New("alerting: incident is not open")

type nopNotifier struct{}

func (nopNotifier) Notify(context.Context, Event) {}

var errNoStore = errors.New("alerting: no incident store configured")

// missingStore stands in for a nil IncidentStore so a wiring mistake shows up
// as logged errors instead of a nil-pointer panic on the ingest path.
type missingStore struct{}

func (missingStore) OpenIncident(context.Context, Incident) (int64, error) { return 0, errNoStore }
func (missingStore) ResolveIncident(context.Context, int64, time.Time, ResolveHow, float64, int) error {
	return errNoStore
}
func (missingStore) SaveProgress(context.Context, int64, float64, float64, int, *time.Time) error {
	return errNoStore
}
func (missingStore) LoadOpenIncidents(context.Context) ([]Incident, error) { return nil, errNoStore }
