# CyberNet — Kiberkafe Boshqaruv Platformasi

**Gaming Center Management Platform — full-stack SaaS solution**

---

## Ozbek tilida

CyberNet — bu kompyuter klublari va kiberkafelar uchun to'liq boshqaruv tizimi.
Platforma sessiya nazorati, to'lovlar, mijozlar bazasi, ombor, statistika va
mobil ilova orqali onlayn bron qilishni bir joyda birlashtiradi.

**Asosiy imkoniyatlar:**

- Kompyuter va sessiyalarni real-time boshqarish (Electron desktop agent)
- Admin panel — kassa, statistika, xodimlar, aksiyalar, sovg'alar
- Mobil ilova (Flutter) — bron qilish, hamyon, do'stlar, turnirlar
- To'lov integratsiyalari: Click, Payme, Uzum, Apelsin, Anor
- Multi-tenant arxitektura (bir necha klublar bitta serverda)
- IP-oq ro'yxat, 2FA, audit log, xavfsizlik boshqaruvi

## In English

CyberNet is a full-fledged management platform for gaming centers and cyber cafes.
The stack combines a Node.js/PostgreSQL backend, a React admin dashboard, a
Flutter mobile client for customers, and an Electron kiosk agent that runs on
each gaming PC.

**Key features:**

- Real-time PC and session control via an Electron desktop agent
- React admin panel — POS, analytics, staff, promotions, loyalty rewards
- Flutter mobile app — bookings, wallet, friends, tournaments, leaderboard
- Payment gateway integrations (Click, Payme, Uzum, Apelsin, Anor)
- Multi-tenant architecture (many clubs on a single server)
- IP allowlist, TOTP 2FA, audit logs, security hardening

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Node.js, Express 5, PostgreSQL, Redis, WebSocket |
| Auth | JWT, bcrypt, TOTP 2FA, refresh-token rotation |
| Admin panel | React 18, React Router, Axios, i18next |
| Desktop agent | Electron, electron-updater, Windows lockdown scripts |
| Mobile app | Flutter 3, Dio, shared_preferences |
| Payments | Click, Payme (Paycom), Uzum, Apelsin, Anor |
| Push | Firebase Cloud Messaging |
| Deploy | PM2, Nginx, Cloudflare Tunnel |

## Repository Layout

```
backend/         Node.js REST API + WebSocket server
admin-panel/     React dashboard for club owners and staff
desktop-agent/   Electron kiosk launcher for gaming PCs
mobile_app/      Flutter customer app (iOS, Android, Web)
```

## Features (short)

- Session timer with automatic time/money accounting
- Kassa (POS) with snack pre-orders and refunds
- Booking system (single, bulk, recurring)
- Membership tiers, promo codes, referral bonuses
- Achievements, leaderboard, gamer profiles
- Tournaments with brackets and prize distribution
- Fiscal receipts, expense tracking, daily reports
- Multi-lab / multi-club support with per-lab theming
- Live announcements and push notifications
- Anti-cheat and access-control tools

---

## Status

**This is a demo / showcase version of the codebase.**

All secrets, API keys, server addresses, and payment credentials have been
replaced with placeholders (`YOUR_SERVER_IP`, `YOUR_JWT_SECRET`, etc.). The
repository is intended as a portfolio reference and does not include the
production configuration, deployment scripts, uploaded assets, or the private
`.env` files.

**Contact for full access, licensing, or a live demo.**
