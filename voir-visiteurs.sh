#!/bin/bash
psql -d hatimedia --pset pager=off -c "SELECT email, created_at FROM users WHERE email LIKE 'anon_%' ORDER BY created_at DESC;"
