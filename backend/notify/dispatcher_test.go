package notify

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const runStopTimeout = 5 * time.Second

type sentCall struct {
	ch  Channel
	msg Message
}

// fakeSender records calls. With block set it waits for ctx, which lets a
// test hold a worker busy until shutdown cancels it.
type fakeSender struct {
	err   error
	delay time.Duration
	block bool
	panic bool

	mu    sync.Mutex
	calls []sentCall
}

func (f *fakeSender) Send(ctx context.Context, ch Channel, msg Message) error {
	if f.panic {
		panic("sender bug")
	}
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, sentCall{ch: ch, msg: msg})
	f.mu.Unlock()
	return f.err
}

func (f *fakeSender) sent() []sentCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentCall(nil), f.calls...)
}

type delivery struct {
	channelID int64
	err       error
}

type fakeRecorder struct {
	mu   sync.Mutex
	recs []delivery
}

func (r *fakeRecorder) RecordDelivery(_ context.Context, channelID int64, _ time.Time, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recs = append(r.recs, delivery{channelID: channelID, err: err})
}

func (r *fakeRecorder) all() []delivery {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]delivery(nil), r.recs...)
}

type fakeLimits struct {
	allow bool
	calls atomic.Int64
}

func (l *fakeLimits) AllowEmail(int64, time.Time) bool {
	l.calls.Add(1)
	return l.allow
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// startDispatcher runs d and returns a stop function that cancels Run and
// waits for it to finish draining.
func startDispatcher(t *testing.T, d *Dispatcher) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()
	return func() {
		t.Helper()
		cancel()
		select {
		case <-done:
		case <-time.After(runStopTimeout):
			t.Fatal("Run did not return after cancel")
		}
	}
}

func slackChannel(id int64, enabled bool) Channel {
	return Channel{ID: id, OrgID: 1, Type: Slack, Name: "ops", Enabled: enabled, Config: ChannelConfig{WebhookURL: validSlackURL}}
}

func TestDispatchDropsWhenQueueFull(t *testing.T) {
	slack := &fakeSender{}
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{Workers: 1, QueueSize: 2}, map[ChannelType]Sender{Slack: slack}, rec, nil, quietLogger())

	// Not running yet, so nothing consumes the queue.
	d.Dispatch([]Channel{slackChannel(1, true), slackChannel(2, true), slackChannel(3, true)}, firedMessage("db-1"))
	if got := d.dropped.Load(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}

	startDispatcher(t, d)()
	if got := len(slack.sent()); got != 2 {
		t.Fatalf("sent = %d, want the 2 queued messages", got)
	}
	if got := len(rec.all()); got != 2 {
		t.Fatalf("records = %d, want 2 (a drop is not an attempt)", got)
	}
}

func TestDispatchSkipsDisabledChannels(t *testing.T) {
	slack := &fakeSender{}
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{Slack: slack}, rec, nil, quietLogger())
	stop := startDispatcher(t, d)

	d.Dispatch([]Channel{slackChannel(1, true), slackChannel(2, false)}, firedMessage("db-1"))
	stop()

	sent := slack.sent()
	if len(sent) != 1 || sent[0].ch.ID != 1 {
		t.Fatalf("sent = %+v, want only channel 1", sent)
	}
	if recs := rec.all(); len(recs) != 1 || recs[0].channelID != 1 {
		t.Fatalf("records = %+v, want only channel 1", recs)
	}
}

func TestDispatchEmailLimitDenied(t *testing.T) {
	email := &fakeSender{}
	slack := &fakeSender{}
	rec := &fakeRecorder{}
	lim := &fakeLimits{allow: false}
	d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{Email: email, Slack: slack}, rec, lim, quietLogger())
	stop := startDispatcher(t, d)

	emailCh := emailChannel("ops@example.com")
	d.Dispatch([]Channel{emailCh, slackChannel(9, true)}, firedMessage("db-1"))
	stop()

	if got := len(email.sent()); got != 0 {
		t.Fatalf("email sent %d times despite the limit", got)
	}
	if got := len(slack.sent()); got != 1 {
		t.Fatalf("slack sent %d times, want 1 (limits only apply to email)", got)
	}
	var emailRec *delivery
	for _, r := range rec.all() {
		if r.channelID == emailCh.ID {
			emailRec = &r
		}
	}
	if emailRec == nil || emailRec.err == nil || emailRec.err.Error() != "daily email limit reached" {
		t.Fatalf("email delivery record = %+v, want the daily limit error", emailRec)
	}
	if got := lim.calls.Load(); got != 1 {
		t.Fatalf("AllowEmail calls = %d, want 1", got)
	}
}

func TestDispatchRefusesCrossOrgChannel(t *testing.T) {
	slack := &fakeSender{}
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{Slack: slack}, rec, nil, quietLogger())
	stop := startDispatcher(t, d)

	other := slackChannel(5, true)
	other.OrgID = 2
	d.Dispatch([]Channel{other}, firedMessage("db-1")) // message is org 1
	stop()

	if got := len(slack.sent()); got != 0 {
		t.Fatalf("org 1 message was sent to an org 2 channel")
	}
	if recs := rec.all(); len(recs) != 1 || !errors.Is(recs[0].err, errOrgMismatch) {
		t.Fatalf("records = %+v, want an org mismatch error", recs)
	}
}

func TestDispatchRecordsMissingSender(t *testing.T) {
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{}, rec, nil, quietLogger())
	stop := startDispatcher(t, d)
	d.Dispatch([]Channel{slackChannel(1, true)}, firedMessage("db-1"))
	stop()

	if recs := rec.all(); len(recs) != 1 || recs[0].err == nil || !strings.Contains(recs[0].err.Error(), "no sender") {
		t.Fatalf("records = %+v, want a missing sender error", recs)
	}
}

func TestTestIsSynchronous(t *testing.T) {
	boom := errors.New("boom")
	tests := []struct {
		name    string
		sender  *fakeSender
		wantErr bool
	}{
		{"success", &fakeSender{}, false},
		{"failure is returned and recorded", &fakeSender{err: boom}, true},
		{"panicking sender becomes an error", &fakeSender{panic: true}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := &fakeRecorder{}
			lim := &fakeLimits{allow: false}
			d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{Email: tt.sender}, rec, lim, quietLogger())
			ch := emailChannel("ops@example.com")
			ch.Enabled = false // a channel can be tested before it is switched on

			// Run is never started: Test must not depend on the worker pool.
			err := d.Test(context.Background(), ch)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Test() = %v, wantErr %v", err, tt.wantErr)
			}
			recs := rec.all()
			if len(recs) != 1 || recs[0].channelID != ch.ID || (recs[0].err != nil) != tt.wantErr {
				t.Fatalf("records = %+v, want one record matching the result", recs)
			}
			if !tt.wantErr {
				sent := tt.sender.sent()
				if len(sent) != 1 || sent[0].msg.Kind != KindTest || sent[0].msg.OrgID != ch.OrgID {
					t.Fatalf("sent = %+v, want one KindTest message for the channel's org", sent)
				}
			}
			if got := lim.calls.Load(); got != 0 {
				t.Fatalf("Test consulted the email limit %d times", got)
			}
		})
	}
}

func TestSendDirect(t *testing.T) {
	email := &fakeSender{}
	rec := &fakeRecorder{}
	lim := &fakeLimits{allow: false}
	d := NewDispatcher(DispatcherConfig{}, map[ChannelType]Sender{Email: email}, rec, lim, quietLogger())
	invite := Message{Kind: KindInvite, OrgID: 1, InviteOrgName: "Acme", InviteURL: "https://app.example.com/invite/abc"}

	if err := d.SendDirect(context.Background(), "New Person <new@example.com>", invite); err != nil {
		t.Fatalf("SendDirect: %v", err)
	}
	sent := email.sent()
	if len(sent) != 1 || len(sent[0].ch.Config.EmailTo) != 1 || sent[0].ch.Config.EmailTo[0] != "new@example.com" || sent[0].msg.Kind != KindInvite {
		t.Fatalf("sent = %+v, want one invite to new@example.com", sent)
	}
	if lim.calls.Load() != 0 || len(rec.all()) != 0 {
		t.Fatal("SendDirect must bypass limits and delivery records")
	}

	errTests := []struct {
		name string
		to   string
		msg  Message
	}{
		{"bad address", "not an address", invite},
		{"header injection", "a@example.com\r\nBcc: b@example.com", invite},
		{"invite without url", "new@example.com", Message{Kind: KindInvite, OrgID: 1, InviteOrgName: "Acme"}},
		{"invite with javascript url", "new@example.com", Message{Kind: KindInvite, OrgID: 1, InviteURL: "javascript:alert(1)"}},
	}
	for _, tt := range errTests {
		t.Run(tt.name, func(t *testing.T) {
			if err := d.SendDirect(context.Background(), tt.to, tt.msg); err == nil {
				t.Fatal("SendDirect succeeded, want error")
			}
		})
	}
	if got := len(email.sent()); got != 1 {
		t.Fatalf("invalid SendDirect calls reached the sender: %d sends", got)
	}
}

func TestRunDrainsQueueOnShutdown(t *testing.T) {
	const queued = 20
	slack := &fakeSender{delay: 2 * time.Millisecond}
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{Workers: 2, QueueSize: queued}, map[ChannelType]Sender{Slack: slack}, rec, nil, quietLogger())

	chs := make([]Channel, queued)
	for i := range chs {
		chs[i] = slackChannel(int64(i+1), true)
	}
	d.Dispatch(chs, firedMessage("db-1"))
	startDispatcher(t, d)() // cancel immediately; Run must still deliver everything queued

	if got := len(slack.sent()); got != queued {
		t.Fatalf("sent = %d, want all %d queued messages", got, queued)
	}
	if got := len(rec.all()); got != queued {
		t.Fatalf("records = %d, want %d", got, queued)
	}

	// After shutdown Dispatch must neither block nor panic on the closed queue.
	d.Dispatch([]Channel{slackChannel(99, true)}, firedMessage("db-1"))
	if got := d.dropped.Load(); got != 1 {
		t.Fatalf("dropped after shutdown = %d, want 1", got)
	}
}

func TestRunAbandonsQueueAfterGrace(t *testing.T) {
	slack := &fakeSender{block: true}
	rec := &fakeRecorder{}
	d := NewDispatcher(DispatcherConfig{Workers: 1, QueueSize: 3, SendTimeout: time.Minute}, map[ChannelType]Sender{Slack: slack}, rec, nil, quietLogger())
	d.grace = 50 * time.Millisecond

	d.Dispatch([]Channel{slackChannel(1, true), slackChannel(2, true), slackChannel(3, true)}, firedMessage("db-1"))
	start := time.Now()
	startDispatcher(t, d)()
	if elapsed := time.Since(start); elapsed > abandonWait {
		t.Fatalf("Run took %v to give up on a stuck sender", elapsed)
	}
	// The in-flight send is cancelled and recorded; the rest are abandoned.
	recs := rec.all()
	if len(recs) != 1 || !errors.Is(recs[0].err, context.Canceled) {
		t.Fatalf("records = %+v, want one cancelled attempt", recs)
	}
}

func TestDispatchNeverBlocks(t *testing.T) {
	slack := &fakeSender{block: true}
	d := NewDispatcher(DispatcherConfig{Workers: 1, QueueSize: 1}, map[ChannelType]Sender{Slack: slack}, nil, nil, quietLogger())
	d.grace = time.Millisecond
	stop := startDispatcher(t, d)
	defer stop()

	done := make(chan struct{})
	go func() {
		for range 100 {
			d.Dispatch([]Channel{slackChannel(1, true)}, firedMessage("db-1"))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(runStopTimeout):
		t.Fatal("Dispatch blocked with a stuck worker and a full queue")
	}
}
