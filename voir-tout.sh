#!/bin/bash
echo ""
echo "═══════════════════════════════════════"
echo "  👥 VISITEURS ANONYMES"
echo "═══════════════════════════════════════"
psql -d hatimedia --pset pager=off -c "SELECT email, created_at FROM users WHERE email LIKE 'anon_%' ORDER BY created_at DESC;"

echo ""
echo "═══════════════════════════════════════"
echo "  💬 DERNIERS MESSAGES"
echo "═══════════════════════════════════════"
psql -d hatimedia --pset pager=off -c "SELECT role, content, created_at FROM messages ORDER BY created_at DESC LIMIT 15;"

echo ""
