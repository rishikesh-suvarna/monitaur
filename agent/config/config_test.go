package config

import "testing"

func TestValidate(t *testing.T) {
	valid := Config{Token: "mt_live_x", APIEndpoint: "wss://example.com/agent/connect", CollectionInterval: 5}
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantErr bool
	}{
		{"valid", func(*Config) {}, false},
		{"missing token", func(c *Config) { c.Token = "" }, true},
		{"zero interval would panic the ticker", func(c *Config) { c.CollectionInterval = 0 }, true},
		{"negative interval", func(c *Config) { c.CollectionInterval = -5 }, true},
		{"interval over a day", func(c *Config) { c.CollectionInterval = maxCollectionInterval + 1 }, true},
		{"one second is allowed", func(c *Config) { c.CollectionInterval = minCollectionInterval }, false},
		{"missing endpoint", func(c *Config) { c.APIEndpoint = "" }, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := valid
			tt.mutate(&c)
			if err := c.validate(); (err != nil) != tt.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
