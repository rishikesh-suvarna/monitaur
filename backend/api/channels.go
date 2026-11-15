package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"backend/auth"
	"backend/notify"
	"backend/store"
)

const (
	// Test sends bypass the daily email budget, so they get their own limit
	// to stop the shared sending identity being used for spam.
	channelTestsPerMinute = 3
	channelTestBurst      = 3
	testTimeout           = 20 * time.Second
)

type channelJSON struct {
	ID             int64             `json:"id"`
	Type           string            `json:"type"`
	Name           string            `json:"name"`
	Enabled        bool              `json:"enabled"`
	Summary        map[string]string `json:"summary"`
	LastDeliveryAt *time.Time        `json:"last_delivery_at"`
	LastDeliveryOK *bool             `json:"last_delivery_ok"`
	LastError      *string           `json:"last_error"`
	CreatedAt      time.Time         `json:"created_at"`
}

func toChannelJSON(c store.Channel) channelJSON {
	out := channelJSON{ID: c.ID, Type: c.Type, Name: c.Name, Enabled: c.Enabled, Summary: map[string]string{},
		LastDeliveryAt: c.LastDeliveryAt, LastDeliveryOK: c.LastDeliveryOK, CreatedAt: c.CreatedAt}
	if c.LastError != "" {
		e := c.LastError
		out.LastError = &e
	}
	if nc, err := ChannelToNotify(c); err == nil {
		out.Summary = nc.Config.Redacted(nc.Type)
	}
	return out
}

func (a *API) reloadOrgChannels(ctx context.Context, orgID int64) error {
	chs, err := a.Store.ListOrgChannels(ctx, orgID)
	if err != nil {
		return err
	}
	a.Dir.SetOrgChannels(orgID, chs)
	return nil
}

func (a *API) listChannels(c *gin.Context) {
	p := auth.MustPrincipal(c)
	chs := a.Dir.OrgChannels(p.OrgID)
	out := make([]channelJSON, 0, len(chs))
	for _, ch := range chs {
		out = append(out, toChannelJSON(ch))
	}
	c.JSON(http.StatusOK, gin.H{"channels": out})
}

func (a *API) createChannel(c *gin.Context) {
	p := auth.MustPrincipal(c)
	var req struct {
		Type    string               `json:"type"`
		Name    string               `json:"name"`
		Enabled *bool                `json:"enabled"`
		Config  notify.ChannelConfig `json:"config"`
	}
	if !bind(c, &req) {
		return
	}
	ch := notify.Channel{OrgID: p.OrgID, Type: notify.ChannelType(req.Type), Name: strings.TrimSpace(req.Name), Enabled: req.Enabled == nil || *req.Enabled, Config: req.Config}
	if err := ch.Validate(); err != nil {
		invalid(c, err.Error())
		return
	}
	cfg, err := json.Marshal(ch.Config)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	created, err := a.Store.CreateChannel(c.Request.Context(), p.OrgID, string(ch.Type), ch.Name, ch.Enabled, cfg, a.Dir.Plan(p.OrgID).MaxChannels)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgChannels(c.Request.Context(), p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"channel": toChannelJSON(created)})
}

func (a *API) patchChannel(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	var req struct {
		Name    *string               `json:"name"`
		Enabled *bool                 `json:"enabled"`
		Config  *notify.ChannelConfig `json:"config"`
	}
	if !bind(c, &req) {
		return
	}
	ctx := c.Request.Context()
	current, err := a.Store.GetChannel(ctx, p.OrgID, id)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	next, err := ChannelToNotify(current)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if req.Name != nil {
		next.Name = strings.TrimSpace(*req.Name)
	}
	if req.Enabled != nil {
		next.Enabled = *req.Enabled
	}
	var cfg []byte
	if req.Config != nil {
		next.Config = *req.Config
		if cfg, err = json.Marshal(next.Config); err != nil {
			a.handleErr(c, err)
			return
		}
	}
	if err := next.Validate(); err != nil {
		invalid(c, err.Error())
		return
	}
	updated, err := a.Store.UpdateChannel(ctx, p.OrgID, id, &next.Name, &next.Enabled, cfg)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgChannels(ctx, p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"channel": toChannelJSON(updated)})
}

func (a *API) deleteChannel(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if err := a.Store.DeleteChannel(ctx, p.OrgID, id); err != nil {
		a.handleErr(c, err)
		return
	}
	if err := a.reloadOrgChannels(ctx, p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	// Rules dropped the channel ID in the same transaction.
	if err := a.reloadOrgRules(ctx, p.OrgID); err != nil {
		a.handleErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *API) testChannel(c *gin.Context) {
	p := auth.MustPrincipal(c)
	id, ok := pathID(c, "id")
	if !ok {
		return
	}
	if !a.Limiter.Allow("channel-test:"+strconv.FormatInt(p.OrgID, 10), channelTestsPerMinute, channelTestBurst) {
		fail(c, http.StatusTooManyRequests, "rate_limited", "wait a minute before sending another test")
		return
	}
	stored, err := a.Store.GetChannel(c.Request.Context(), p.OrgID, id)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	ch, err := ChannelToNotify(stored)
	if err != nil {
		a.handleErr(c, err)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), testTimeout)
	defer cancel()
	sendErr := a.Dispatcher.Test(ctx, ch)
	a.Dir.UpdateChannelDelivery(ch.ID, a.Now(), sendErr)
	if sendErr != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "error": sendErr.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
