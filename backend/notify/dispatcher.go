package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"sync"
	"sync/atomic"
	"time"
)

// Sender delivers one message to one channel. Implementations must respect
// ctx cancellation and return errors that are safe to show the tenant.
type Sender interface {
	Send(ctx context.Context, ch Channel, msg Message) error
}

// DeliveryRecorder stores the outcome of every delivery attempt (err nil on
// success) so the API can show last_delivery_at / last_error per channel.
type DeliveryRecorder interface {
	RecordDelivery(ctx context.Context, channelID int64, at time.Time, err error)
}

// Limits enforces per-org quotas on alert email.
type Limits interface {
	// AllowEmail reports whether org may send one more alert email today.
	AllowEmail(orgID int64, now time.Time) bool
}

// DispatcherConfig sizes the worker pool. Zero values take defaults.
type DispatcherConfig struct {
	Workers     int
	QueueSize   int
	SendTimeout time.Duration
}

const (
	defaultWorkers     = 4
	defaultQueueSize   = 1024
	defaultSendTimeout = 15 * time.Second
	// drainGrace bounds shutdown: queued messages get this long to go out
	// before in-flight sends are cancelled and the rest are abandoned.
	drainGrace = 10 * time.Second
	// abandonWait bounds the wait for workers after cancellation, so a
	// sender that ignores ctx cannot hang process shutdown.
	abandonWait   = 2 * time.Second
	recordTimeout = 5 * time.Second
	directName    = "direct"
)

var (
	errEmailLimit  = errors.New("daily email limit reached")
	errOrgMismatch = errors.New("channel belongs to a different organization than the message")
)

type job struct {
	ch  Channel
	msg Message
}

// Dispatcher fans messages out to channels through a bounded queue so the
// alerting engine never waits on a slow webhook or SMTP relay.
type Dispatcher struct {
	cfg     DispatcherConfig
	senders map[ChannelType]Sender
	rec     DeliveryRecorder
	lim     Limits
	log     *slog.Logger
	now     func() time.Time
	grace   time.Duration

	mu      sync.RWMutex // guards closed and the close of queue
	closed  bool
	queue   chan job
	started atomic.Bool
	dropped atomic.Int64
}

// NewDispatcher builds a dispatcher. A nil rec discards delivery records, a
// nil lim means unlimited email (self-hosted), and a nil log uses
// slog.Default.
func NewDispatcher(cfg DispatcherConfig, senders map[ChannelType]Sender, rec DeliveryRecorder, lim Limits, log *slog.Logger) *Dispatcher {
	if cfg.Workers <= 0 {
		cfg.Workers = defaultWorkers
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = defaultQueueSize
	}
	if cfg.SendTimeout <= 0 {
		cfg.SendTimeout = defaultSendTimeout
	}
	if rec == nil {
		rec = nopRecorder{}
	}
	if lim == nil {
		lim = unlimited{}
	}
	if log == nil {
		log = slog.Default()
	}
	// Copy so a caller mutating its map later cannot race the workers.
	s := make(map[ChannelType]Sender, len(senders))
	for t, snd := range senders {
		if snd != nil {
			s[t] = snd
		}
	}
	return &Dispatcher{
		cfg:     cfg,
		senders: s,
		rec:     rec,
		lim:     lim,
		log:     log.With("component", "notify"),
		now:     time.Now,
		grace:   drainGrace,
		queue:   make(chan job, cfg.QueueSize),
	}
}

// Run starts the worker pool and blocks until ctx is done. It then stops
// accepting messages and drains the queue for up to the grace period.
func (d *Dispatcher) Run(ctx context.Context) {
	if !d.started.CompareAndSwap(false, true) {
		d.log.Error("notify dispatcher Run called more than once")
		return
	}
	// Sends must outlive ctx so the queue can drain after shutdown starts;
	// cancelSends ends them once the grace period is over.
	sendCtx, cancelSends := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelSends()

	var wg sync.WaitGroup
	for range d.cfg.Workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d.worker(sendCtx)
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	<-ctx.Done()
	d.mu.Lock()
	d.closed = true
	close(d.queue)
	d.mu.Unlock()

	pending := len(d.queue)
	if pending > 0 {
		d.log.Info("draining notification queue", "pending", pending)
	}
	grace := time.NewTimer(d.grace)
	defer grace.Stop()
	select {
	case <-done:
		return
	case <-grace.C:
	}

	cancelSends()
	d.log.Warn("notification drain timed out, abandoning remaining messages", "pending", len(d.queue))
	abandon := time.NewTimer(abandonWait)
	defer abandon.Stop()
	select {
	case <-done:
	case <-abandon.C:
		d.log.Error("notification workers did not stop after cancellation")
	}
}

func (d *Dispatcher) worker(ctx context.Context) {
	for j := range d.queue {
		if ctx.Err() != nil {
			// Past the grace period: keep emptying the queue without sending.
			continue
		}
		d.deliver(ctx, j.ch, j.msg)
	}
}

// Dispatch queues msg for every enabled channel. It never blocks: when the
// queue is full, or the dispatcher has shut down, the message is dropped and
// logged. Quota checks and delivery records happen on the worker, because
// both may do I/O.
func (d *Dispatcher) Dispatch(chs []Channel, msg Message) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, ch := range chs {
		if !ch.Enabled {
			continue
		}
		if d.closed {
			d.drop(ch, msg, "dispatcher stopped")
			continue
		}
		select {
		case d.queue <- job{ch: ch, msg: msg}:
		default:
			d.drop(ch, msg, "queue full")
		}
	}
}

func (d *Dispatcher) drop(ch Channel, msg Message, reason string) {
	total := d.dropped.Add(1)
	d.log.Warn("notification dropped",
		"reason", reason,
		"channel_id", ch.ID,
		"channel_type", string(ch.Type),
		"org_id", ch.OrgID,
		"incident_id", msg.IncidentID,
		"kind", string(msg.Kind),
		"dropped_total", total)
}

// deliver performs one queued attempt and always records its outcome.
func (d *Dispatcher) deliver(ctx context.Context, ch Channel, msg Message) {
	var err error
	switch {
	case ch.OrgID != msg.OrgID:
		// A cross-tenant pairing is a bug upstream; refusing it here keeps one
		// tenant's incident from ever reaching another tenant's channel.
		err = errOrgMismatch
		d.log.Error("refusing cross-org notification", "channel_id", ch.ID, "channel_org_id", ch.OrgID, "message_org_id", msg.OrgID)
	case ch.Type == Email && isAlertKind(msg.Kind) && !d.lim.AllowEmail(ch.OrgID, d.now()):
		err = errEmailLimit
	default:
		err = d.send(ctx, ch, msg)
	}
	d.record(ctx, ch, msg.Kind, err)
}

// send applies the per-send timeout and shields the pool from a panicking
// sender: a bug in one integration must not stop alerting for every tenant.
func (d *Dispatcher) send(ctx context.Context, ch Channel, msg Message) (err error) {
	sender, ok := d.senders[ch.Type]
	if !ok {
		return fmt.Errorf("no sender configured for %s channels", ch.Type)
	}
	sendCtx, cancel := context.WithTimeout(ctx, d.cfg.SendTimeout)
	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			d.log.Error("notification sender panicked", "channel_type", string(ch.Type), "panic", fmt.Sprint(r))
			err = fmt.Errorf("%s sender failed unexpectedly", ch.Type)
		}
	}()
	return sender.Send(sendCtx, ch, msg)
}

func (d *Dispatcher) record(ctx context.Context, ch Channel, kind MessageKind, err error) {
	if err != nil {
		d.log.Warn("notification delivery failed",
			"channel_id", ch.ID, "channel_type", string(ch.Type), "org_id", ch.OrgID, "kind", string(kind), "error", err.Error())
	} else {
		d.log.Debug("notification delivered",
			"channel_id", ch.ID, "channel_type", string(ch.Type), "org_id", ch.OrgID, "kind", string(kind))
	}
	// Recording gets its own budget: the send may have used up (or been
	// cancelled by) the caller's context, and the outcome still matters.
	recCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
	defer cancel()
	d.rec.RecordDelivery(recCtx, ch.ID, d.now(), err)
}

// Test sends a KindTest message to ch synchronously, records the outcome and
// returns the send error. It ignores ch.Enabled so a channel can be checked
// before it is switched on, and does not count against the email quota.
func (d *Dispatcher) Test(ctx context.Context, ch Channel) error {
	err := d.send(ctx, ch, Message{Kind: KindTest, OrgID: ch.OrgID})
	d.record(ctx, ch, KindTest, err)
	return err
}

// SendDirect emails msg to a single address through the email sender,
// bypassing channels, Limits and delivery records. It exists for invites.
func (d *Dispatcher) SendDirect(ctx context.Context, to string, msg Message) error {
	addr, err := mail.ParseAddress(to)
	if err != nil {
		return fmt.Errorf("invalid recipient address: %w", err)
	}
	if msg.Kind == KindInvite && safeLink(msg.InviteURL) == "" {
		return errors.New("invite url must be an absolute http(s) URL")
	}
	ch := Channel{
		OrgID:   msg.OrgID,
		Type:    Email,
		Name:    directName,
		Enabled: true,
		Config:  ChannelConfig{EmailTo: []string{addr.Address}},
	}
	return d.send(ctx, ch, msg)
}

type nopRecorder struct{}

func (nopRecorder) RecordDelivery(context.Context, int64, time.Time, error) {}

type unlimited struct{}

func (unlimited) AllowEmail(int64, time.Time) bool { return true }
