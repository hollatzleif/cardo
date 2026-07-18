//! Spaced-repetition scheduling core (Anki-class). Pure and storage-free so it
//! unit-tests without a DB, host or UI. The tool layer persists a [`CardState`]
//! per card and calls [`sm2_review`] with the user's answer to get the updated
//! state plus the delay until the card is next due.
//!
//! Two schedulers live behind the same [`CardState`]: **SM-2** (this file) and
//! **FSRS** (added next – it reads/writes the `stability`/`difficulty` fields,
//! which SM-2 leaves untouched). Anki's four answer buttons map to [`Rating`].

use serde::{Deserialize, Serialize};

/// The four answer buttons, matching Anki (Again=1 … Easy=4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rating {
    Again,
    Hard,
    Good,
    Easy,
}

/// Where a card sits in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    New,
    Learning,
    Review,
    Relearning,
}

/// Delay until the card is next due. Sub-day steps stay in minutes; graduated
/// cards are scheduled in whole days (the tool turns this into a due date).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    Minutes(u32),
    Days(u32),
}

/// The full scheduling state persisted per card. FSRS-only fields
/// (`stability`, `difficulty`) default to 0 and are ignored by SM-2, so a card
/// can move between schedulers without a migration.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardState {
    pub phase: Phase,
    /// SM-2 ease factor (permille as a float, e.g. 2.5). Floored by config.
    pub ease: f64,
    /// Current review interval in days. During (re)learning it holds the
    /// interval the card will resume with once it graduates.
    pub interval_days: u32,
    /// Successful review answers so far (informational).
    pub reps: u32,
    /// How often the card lapsed (Again while in Review).
    pub lapses: u32,
    /// Index into the active (re)learning step list.
    pub step: u32,
    /// FSRS memory stability (days). 0 until the FSRS scheduler touches it.
    #[serde(default)]
    pub stability: f64,
    /// FSRS difficulty (1–10). 0 until the FSRS scheduler touches it.
    #[serde(default)]
    pub difficulty: f64,
}

impl CardState {
    /// A brand-new, never-studied card.
    pub fn new(cfg: &Sm2Config) -> Self {
        Self {
            phase: Phase::New,
            ease: cfg.starting_ease,
            interval_days: 0,
            reps: 0,
            lapses: 0,
            step: 0,
            stability: 0.0,
            difficulty: 0.0,
        }
    }
}

/// Deck-level scheduling options (Anki defaults).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sm2Config {
    /// Learning steps in minutes (New/Learning phase).
    pub learning_steps_min: Vec<u32>,
    /// Relearning steps in minutes (after a lapse).
    pub relearning_steps_min: Vec<u32>,
    /// Interval (days) a card graduates to on the last learning step with Good.
    pub graduating_interval_days: u32,
    /// Interval (days) a card graduates to when answered Easy in learning.
    pub easy_interval_days: u32,
    pub starting_ease: f64,
    pub min_ease: f64,
    /// Extra multiplier applied to Easy review intervals.
    pub easy_bonus: f64,
    /// Multiplier for Hard review intervals.
    pub hard_interval_factor: f64,
    /// Global multiplier on all review intervals.
    pub interval_modifier: f64,
    /// Fraction of the old interval kept after a lapse (Anki "new interval").
    pub lapse_interval_factor: f64,
    /// Floor for any review interval, in days.
    pub minimum_interval_days: u32,
}

impl Default for Sm2Config {
    fn default() -> Self {
        Self {
            learning_steps_min: vec![1, 10],
            relearning_steps_min: vec![10],
            graduating_interval_days: 1,
            easy_interval_days: 4,
            starting_ease: 2.5,
            min_ease: 1.3,
            easy_bonus: 1.3,
            hard_interval_factor: 1.2,
            interval_modifier: 1.0,
            lapse_interval_factor: 0.0,
            minimum_interval_days: 1,
        }
    }
}

fn round_days(x: f64) -> u32 {
    x.round().max(1.0) as u32
}

/// Apply one answer to a card, returning the new state and the delay until it
/// is next due. Faithful to Anki's SM-2 scheduler: learning/relearning steps,
/// per-rating ease changes, lapses, and a monotonic review interval.
pub fn sm2_review(state: &CardState, rating: Rating, cfg: &Sm2Config) -> (CardState, Interval) {
    let mut s = *state;

    // A new card enters learning at step 0 before the answer is processed.
    if s.phase == Phase::New {
        s.phase = Phase::Learning;
        s.step = 0;
    }

    match s.phase {
        Phase::Learning => step_through(&mut s, rating, &cfg.learning_steps_min, cfg, false),
        Phase::Relearning => step_through(&mut s, rating, &cfg.relearning_steps_min, cfg, true),
        Phase::Review => review_answer(&mut s, rating, cfg),
        Phase::New => unreachable!("New was converted to Learning above"),
    }
}

/// Learning or relearning: walk the step list; graduate to Review at the end.
fn step_through(
    s: &mut CardState,
    rating: Rating,
    steps: &[u32],
    cfg: &Sm2Config,
    relearning: bool,
) -> (CardState, Interval) {
    let last = steps.len().saturating_sub(1) as u32;
    match rating {
        Rating::Again => {
            s.step = 0;
            (*s, Interval::Minutes(step_minutes(steps, 0)))
        }
        Rating::Hard => (*s, Interval::Minutes(step_minutes(steps, s.step))),
        Rating::Good => {
            if s.step >= last {
                graduate(s, cfg, relearning, false)
            } else {
                s.step += 1;
                (*s, Interval::Minutes(step_minutes(steps, s.step)))
            }
        }
        Rating::Easy => graduate(s, cfg, relearning, true),
    }
}

fn step_minutes(steps: &[u32], idx: u32) -> u32 {
    *steps.get(idx as usize).or_else(|| steps.last()).unwrap_or(&1)
}

/// Leave (re)learning for the Review phase.
fn graduate(
    s: &mut CardState,
    cfg: &Sm2Config,
    relearning: bool,
    easy: bool,
) -> (CardState, Interval) {
    s.phase = Phase::Review;
    s.step = 0;
    s.reps += 1;
    if relearning {
        // interval_days already holds the post-lapse interval; Easy nudges it.
        if easy {
            s.interval_days = s.interval_days.saturating_add(1);
        }
    } else {
        s.interval_days = if easy { cfg.easy_interval_days } else { cfg.graduating_interval_days };
    }
    s.interval_days = s.interval_days.max(cfg.minimum_interval_days);
    (*s, Interval::Days(s.interval_days))
}

/// A card already in the Review phase.
fn review_answer(s: &mut CardState, rating: Rating, cfg: &Sm2Config) -> (CardState, Interval) {
    let prev = s.interval_days.max(1);
    match rating {
        Rating::Again => {
            // Lapse: drop ease, remember the reduced interval, relearn.
            s.lapses += 1;
            s.ease = (s.ease - 0.20).max(cfg.min_ease);
            s.phase = Phase::Relearning;
            s.step = 0;
            let reduced = round_days(f64::from(prev) * cfg.lapse_interval_factor);
            s.interval_days = reduced.max(cfg.minimum_interval_days);
            (*s, Interval::Minutes(step_minutes(&cfg.relearning_steps_min, 0)))
        }
        Rating::Hard => {
            s.ease = (s.ease - 0.15).max(cfg.min_ease);
            let next = round_days(f64::from(prev) * cfg.hard_interval_factor * cfg.interval_modifier);
            s.interval_days = next.max(prev + 1);
            s.reps += 1;
            (*s, Interval::Days(s.interval_days))
        }
        Rating::Good => {
            let next = round_days(f64::from(prev) * s.ease * cfg.interval_modifier);
            s.interval_days = next.max(prev + 1);
            s.reps += 1;
            (*s, Interval::Days(s.interval_days))
        }
        Rating::Easy => {
            s.ease = (s.ease + 0.15).max(cfg.min_ease);
            let next =
                round_days(f64::from(prev) * s.ease * cfg.easy_bonus * cfg.interval_modifier);
            s.interval_days = next.max(prev + 1);
            s.reps += 1;
            (*s, Interval::Days(s.interval_days))
        }
    }
}

/* ── FSRS (Anki's modern default) ─────────────────────────────────────── */

/// Which scheduler a deck uses. FSRS is the default (Anki's modern algorithm).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Scheduler {
    #[default]
    Fsrs,
    Sm2,
}

/// FSRS options. Empty `params` = the crate's trained default weights.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsConfig {
    /// FSRS weights. Empty uses the library defaults; a trained set can be
    /// supplied later once review history exists.
    pub params: Vec<f32>,
    /// Probability of recall the scheduler aims for (Anki default 0.9).
    pub desired_retention: f32,
}

impl Default for FsrsConfig {
    fn default() -> Self {
        Self { params: Vec::new(), desired_retention: 0.9 }
    }
}

fn interval_from_days(days: f32) -> Interval {
    if days < 1.0 {
        Interval::Minutes(((days * 1440.0).round() as i64).clamp(1, 1440) as u32)
    } else {
        Interval::Days(days.round().max(1.0) as u32)
    }
}

/// One FSRS review. Reads/writes the `stability`/`difficulty` memory fields on
/// [`CardState`]; `elapsed_days` is how long since the card was last due.
pub fn fsrs_review(
    state: &CardState,
    rating: Rating,
    cfg: &FsrsConfig,
    elapsed_days: u32,
) -> Result<(CardState, Interval), String> {
    let fsrs = fsrs::FSRS::new(&cfg.params).map_err(|e| format!("fsrs init: {e}"))?;
    let memory = if state.stability > 0.0 {
        Some(fsrs::MemoryState {
            stability: state.stability as f32,
            difficulty: state.difficulty as f32,
        })
    } else {
        None
    };
    let next = fsrs
        .next_states(memory, cfg.desired_retention, elapsed_days)
        .map_err(|e| format!("fsrs next_states: {e}"))?;
    let item = match rating {
        Rating::Again => next.again,
        Rating::Hard => next.hard,
        Rating::Good => next.good,
        Rating::Easy => next.easy,
    };

    let mut s = *state;
    s.stability = f64::from(item.memory.stability);
    s.difficulty = f64::from(item.memory.difficulty);
    s.phase = Phase::Review; // FSRS drives long-term memory directly.
    if rating == Rating::Again {
        s.lapses += 1;
    } else {
        s.reps += 1;
    }
    let interval = interval_from_days(item.interval);
    if let Interval::Days(d) = interval {
        s.interval_days = d;
    }
    Ok((s, interval))
}

/// Scheduler-agnostic entry point the tool layer calls.
pub fn review(
    scheduler: Scheduler,
    state: &CardState,
    rating: Rating,
    elapsed_days: u32,
    sm2: &Sm2Config,
    fsrs: &FsrsConfig,
) -> Result<(CardState, Interval), String> {
    match scheduler {
        Scheduler::Sm2 => Ok(sm2_review(state, rating, sm2)),
        Scheduler::Fsrs => fsrs_review(state, rating, fsrs, elapsed_days),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Sm2Config {
        Sm2Config::default()
    }

    fn to_days(iv: Interval) -> f64 {
        match iv {
            Interval::Minutes(m) => f64::from(m) / 1440.0,
            Interval::Days(d) => f64::from(d),
        }
    }

    #[test]
    fn new_card_good_walks_learning_then_graduates() {
        let c = cfg();
        let card = CardState::new(&c);
        assert_eq!(card.phase, Phase::New);

        // First Good: New → Learning, advance to step 1 (10 min).
        let (card, iv) = sm2_review(&card, Rating::Good, &c);
        assert_eq!(card.phase, Phase::Learning);
        assert_eq!(card.step, 1);
        assert_eq!(iv, Interval::Minutes(10));

        // Second Good: last step → graduate to Review with 1 day.
        let (card, iv) = sm2_review(&card, Rating::Good, &c);
        assert_eq!(card.phase, Phase::Review);
        assert_eq!(iv, Interval::Days(1));
    }

    #[test]
    fn easy_in_learning_graduates_immediately() {
        let c = cfg();
        let (card, iv) = sm2_review(&CardState::new(&c), Rating::Easy, &c);
        assert_eq!(card.phase, Phase::Review);
        assert_eq!(iv, Interval::Days(4));
    }

    #[test]
    fn again_in_learning_resets_to_first_step() {
        let c = cfg();
        // Move to step 1 first.
        let (card, _) = sm2_review(&CardState::new(&c), Rating::Good, &c);
        assert_eq!(card.step, 1);
        let (card, iv) = sm2_review(&card, Rating::Again, &c);
        assert_eq!(card.phase, Phase::Learning);
        assert_eq!(card.step, 0);
        assert_eq!(iv, Interval::Minutes(1));
    }

    fn graduated() -> (CardState, Sm2Config) {
        let c = cfg();
        let (card, _) = sm2_review(&CardState::new(&c), Rating::Easy, &c); // Review, 4 days
        (card, c)
    }

    #[test]
    fn review_good_grows_by_ease() {
        // Easy in learning graduates but does NOT change ease (Anki-correct);
        // only Easy in Review does. So ease is still 2.5 here, interval 4.
        let (card, c) = graduated();
        assert_eq!(card.ease, 2.5);
        let (next, iv) = sm2_review(&card, Rating::Good, &c);
        // round(4 * 2.5) = 10
        assert_eq!(iv, Interval::Days(10));
        assert_eq!(next.interval_days, 10);
        assert!(next.interval_days > card.interval_days);
    }

    #[test]
    fn hard_is_smaller_than_good_and_lowers_ease() {
        let (card, c) = graduated();
        let (hard, hard_iv) = sm2_review(&card, Rating::Hard, &c);
        let (_good, good_iv) = sm2_review(&card, Rating::Good, &c);
        assert!(matches!((hard_iv, good_iv), (Interval::Days(h), Interval::Days(g)) if h < g));
        assert!(hard.ease < card.ease);
    }

    #[test]
    fn easy_review_raises_ease_and_beats_good() {
        let (card, c) = graduated();
        let (easy, easy_iv) = sm2_review(&card, Rating::Easy, &c);
        let (_good, good_iv) = sm2_review(&card, Rating::Good, &c);
        assert!(matches!((easy_iv, good_iv), (Interval::Days(e), Interval::Days(g)) if e > g));
        assert!(easy.ease > card.ease);
    }

    #[test]
    fn again_in_review_lapses_into_relearning() {
        let (card, c) = graduated();
        let (lapsed, iv) = sm2_review(&card, Rating::Again, &c);
        assert_eq!(lapsed.phase, Phase::Relearning);
        assert_eq!(lapsed.lapses, 1);
        assert!(lapsed.ease < card.ease); // −0.20
        assert_eq!(iv, Interval::Minutes(10));
        assert_eq!(lapsed.interval_days, 1); // 4 * 0.0 → floored to minimum 1

        // Good in relearning graduates back to Review with that interval.
        let (back, back_iv) = sm2_review(&lapsed, Rating::Good, &c);
        assert_eq!(back.phase, Phase::Review);
        assert_eq!(back_iv, Interval::Days(1));
    }

    #[test]
    fn ease_never_drops_below_floor() {
        let c = cfg();
        let mut card = graduated().0;
        for _ in 0..20 {
            card = sm2_review(&card, Rating::Hard, &c).0;
        }
        assert!(card.ease >= c.min_ease - f64::EPSILON);
    }

    #[test]
    fn card_state_survives_json_roundtrip() {
        let c = cfg();
        let card = sm2_review(&CardState::new(&c), Rating::Good, &c).0;
        let json = serde_json::to_string(&card).unwrap();
        let back: CardState = serde_json::from_str(&json).unwrap();
        assert_eq!(card, back);
    }

    #[test]
    fn fsrs_fields_default_when_absent_from_json() {
        // Old cards persisted before FSRS existed have no stability/difficulty.
        let legacy = r#"{"phase":"review","ease":2.5,"intervalDays":3,"reps":1,"lapses":0,"step":0}"#;
        let card: CardState = serde_json::from_str(legacy).unwrap();
        assert_eq!(card.stability, 0.0);
        assert_eq!(card.difficulty, 0.0);
    }

    /* ── FSRS ──────────────────────────────────────────────────────────── */

    #[test]
    fn fsrs_new_card_gains_memory_and_orders_buttons() {
        let fc = FsrsConfig::default();
        let fresh = CardState::new(&cfg());
        let (good, _) = fsrs_review(&fresh, Rating::Good, &fc, 0).unwrap();
        assert!(good.stability > 0.0, "stability must be set after a review");
        assert!((1.0..=10.0).contains(&good.difficulty), "difficulty in [1,10]");

        // On a card with memory, later buttons never schedule sooner.
        let e = good.interval_days;
        let again = to_days(fsrs_review(&good, Rating::Again, &fc, e).unwrap().1);
        let hard = to_days(fsrs_review(&good, Rating::Hard, &fc, e).unwrap().1);
        let g = to_days(fsrs_review(&good, Rating::Good, &fc, e).unwrap().1);
        let easy = to_days(fsrs_review(&good, Rating::Easy, &fc, e).unwrap().1);
        assert!(
            again <= hard && hard <= g && g <= easy,
            "again={again} hard={hard} good={g} easy={easy}",
        );
    }

    #[test]
    fn fsrs_higher_retention_means_shorter_intervals() {
        let fresh = CardState::new(&cfg());
        let low = FsrsConfig { desired_retention: 0.80, ..FsrsConfig::default() };
        let high = FsrsConfig { desired_retention: 0.95, ..FsrsConfig::default() };
        let iv_low = to_days(fsrs_review(&fresh, Rating::Good, &low, 0).unwrap().1);
        let iv_high = to_days(fsrs_review(&fresh, Rating::Good, &high, 0).unwrap().1);
        assert!(iv_low >= iv_high, "lower retention should not schedule sooner");
    }

    #[test]
    fn fsrs_again_lapses_and_weakens_memory_versus_good() {
        let fc = FsrsConfig::default();
        let (good, _) = fsrs_review(&CardState::new(&cfg()), Rating::Good, &fc, 0).unwrap();
        let (again, _) = fsrs_review(&good, Rating::Again, &fc, good.interval_days).unwrap();
        let (good2, _) = fsrs_review(&good, Rating::Good, &fc, good.interval_days).unwrap();
        assert!(again.stability < good2.stability, "Again must not strengthen more than Good");
        assert_eq!(again.lapses, 1);
    }

    #[test]
    fn review_dispatch_picks_the_scheduler() {
        let sm2 = cfg();
        let fc = FsrsConfig::default();
        let fresh = CardState::new(&sm2);
        let (via_sm2, _) = review(Scheduler::Sm2, &fresh, Rating::Easy, 0, &sm2, &fc).unwrap();
        assert_eq!(via_sm2.interval_days, 4); // SM-2 easy graduate
        let (via_fsrs, _) = review(Scheduler::Fsrs, &fresh, Rating::Good, 0, &sm2, &fc).unwrap();
        assert!(via_fsrs.stability > 0.0); // FSRS set memory
        assert_eq!(Scheduler::default(), Scheduler::Fsrs); // FSRS is the default
    }
}
