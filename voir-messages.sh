#!/bin/bash
psql -d hatimedia --pset pager=off -c "SELECT role, content, created_at FROM messages ORDER BY created_at DESC LIMIT 30;"
