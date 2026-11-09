-- Quintara TV: series, episodes and each viewer's place in them.

CREATE TABLE tv_series (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id  UUID NOT NULL REFERENCES markets(id),
  title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  summary    TEXT NOT NULL DEFAULT '',
  image_id   UUID REFERENCES media(id),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, title)
);

CREATE TABLE tv_episodes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id        UUID NOT NULL REFERENCES tv_series(id) ON DELETE CASCADE,
  number           INT NOT NULL CHECK (number >= 1),
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  summary          TEXT NOT NULL DEFAULT '',
  duration_seconds INT NOT NULL CHECK (duration_seconds BETWEEN 1 AND 86400),
  -- Where the video is streamed from. The file itself lives with a video host, not in this database.
  video_url        TEXT CHECK (video_url IS NULL OR video_url LIKE 'https://%'),
  -- 'public' episodes can be watched by anyone; 'members' episodes only by members.
  audience         TEXT NOT NULL DEFAULT 'members' CHECK (audience IN ('public', 'members')),
  image_id         UUID REFERENCES media(id),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_id, number)
);

-- Where a member stopped, so they can carry on from any device.
CREATE TABLE tv_progress (
  member_id        UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  episode_id       UUID NOT NULL REFERENCES tv_episodes(id) ON DELETE CASCADE,
  position_seconds INT NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  completed        BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, episode_id)
);
