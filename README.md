# 3D Soccer List

An independent competitive ranking and player community for 3D Soccer.

## Project status

Early development. The repository is public and the application is being built.

## Planned features

- Player accounts and customizable profiles
- Seven competitive divisions
- 4v4 match submissions with evidence
- Staff review and approval workflow
- Player statistics, match history, and leaderboard
- Supabase authentication and database

## Competitive settings

- Match format: 4v4
- Dribbling control: Manual (Hard)

## Points system

| Opponent level | Win | Loss |
|---|---:|---:|
| Same division | +30 | -30 |
| Lower division | +15 | -45 |
| Higher division | +45 | -15 |

## Divisions

| Division | Category | Points |
|---|---|---:|
| Beginner | Beginner | 0–500 |
| Intermediate | Intermediate | 501–1,000 |
| Advanced | Advanced | 1,001–1,500 |
| Professional | Elite | 1,501–2,000 |
| Legend | Competitive | 2,001–3,000 |
| Master | High-Level | 3,001–4,000 |
| Professor | Absolute Top | 4,001–5,000 |

## Development setup

The frontend is a static site. Supabase will provide authentication and persistent data.

1. Create a Supabase project.
2. Run the SQL in `supabase/schema.sql`.
3. Copy `js/supabase-config.example.js` to `js/supabase-config.js`.
4. Add your Supabase project URL and publishable (anon) key to that local config file.
5. Open `index.html` through a local development server or deploy it to static hosting.

Never commit a Supabase `service_role` key, database password, or other secret.

## License

MIT. See [LICENSE](LICENSE).
