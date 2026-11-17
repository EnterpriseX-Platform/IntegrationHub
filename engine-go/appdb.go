package main

// Access to the application's own database (baskets, basket files, sessions,
// executions, connections). The Node executors reach it through Prisma; the
// Go executors use the same DATABASE_URL directly.

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	appPoolOnce sync.Once
	appPool     *pgxpool.Pool
	appPoolErr  error
)

// appDB returns the pool for the application database (env DATABASE_URL).
func appDB() (*pgxpool.Pool, error) {
	appPoolOnce.Do(func() {
		url := os.Getenv("DATABASE_URL")
		if url == "" {
			appPoolErr = fmt.Errorf("engine: DATABASE_URL is not set")
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		appPool, appPoolErr = pgxpool.New(ctx, url)
	})
	return appPool, appPoolErr
}

// appQuery runs a query on the application database and returns rows as
// maps keyed by column name.
func appQuery(sql string, args ...any) ([]map[string]any, error) {
	pool, err := appDB()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}

// appExec runs a statement on the application database and returns the
// number of affected rows.
func appExec(sql string, args ...any) (int64, error) {
	pool, err := appDB()
	if err != nil {
		return 0, err
	}
	tag, err := pool.Exec(context.Background(), sql, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// newCUID returns a collision-resistant id in the same shape Prisma's
// @default(cuid()) produces ("c" + 24 lowercase base36 chars).
func newCUID() string {
	return cuid()
}
