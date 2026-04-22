#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env, String};

const DAY_IN_SECONDS: u64 = 86_400;
const WEEK_IN_SECONDS: u64 = 604_800;

pub const MIN_WORKOUT_MINUTES: u32 = 5;
pub const MAX_WORKOUT_MINUTES: u32 = 480;
pub const MIN_GOAL_MINUTES: u32 = 30;
pub const MAX_GOAL_MINUTES: u32 = 5_000;

#[derive(Clone)]
#[contracttype]
pub struct WorkoutProfile {
    pub display_name: String,
    pub created_at: u64,
    pub last_workout_day: u64,
    pub active_week: u64,
    pub weekly_goal_minutes: u32,
    pub total_minutes: u32,
    pub minutes_this_week: u32,
    pub session_count: u32,
    pub current_streak: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct WorkoutSession {
    pub workout_type: String,
    pub minutes_spent: u32,
    pub timestamp: u64,
    pub streak_after_log: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct Dashboard {
    pub display_name: String,
    pub weekly_goal_minutes: u32,
    pub total_minutes: u32,
    pub minutes_this_week: u32,
    pub session_count: u32,
    pub current_streak: u32,
    pub created_at: u64,
    pub goal_reached_this_week: bool,
}

#[contractevent]
#[derive(Clone)]
pub struct ProfileSaved {
    #[topic]
    pub athlete: Address,
    pub display_name: String,
    pub weekly_goal_minutes: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct WeeklyGoalUpdated {
    #[topic]
    pub athlete: Address,
    pub weekly_goal_minutes: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct WorkoutLogged {
    #[topic]
    pub athlete: Address,
    pub workout_type: String,
    pub minutes_spent: u32,
    pub minutes_this_week: u32,
    pub current_streak: u32,
}

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Profile(Address),
    Session(Address, u32),
}

#[contract]
pub struct WorkoutForge;

#[contractimpl]
impl WorkoutForge {
    pub fn save_profile(env: Env, athlete: Address, display_name: String, weekly_goal_minutes: u32) {
        athlete.require_auth();
        validate_display_name(&display_name);
        validate_weekly_goal(weekly_goal_minutes);

        let now = env.ledger().timestamp();
        let current_week = current_week(&env);

        let mut profile = read_profile_optional(&env, &athlete).unwrap_or(WorkoutProfile {
            display_name: display_name.clone(),
            created_at: now,
            last_workout_day: 0,
            active_week: current_week,
            weekly_goal_minutes,
            total_minutes: 0,
            minutes_this_week: 0,
            session_count: 0,
            current_streak: 0,
        });

        sync_week(&mut profile, current_week);
        profile.display_name = display_name.clone();
        profile.weekly_goal_minutes = weekly_goal_minutes;

        write_profile(&env, &athlete, &profile);
        ProfileSaved {
            athlete,
            display_name,
            weekly_goal_minutes,
        }
        .publish(&env);
    }

    pub fn update_weekly_goal(env: Env, athlete: Address, new_goal_minutes: u32) {
        athlete.require_auth();
        validate_weekly_goal(new_goal_minutes);

        let mut profile = read_profile_required(&env, &athlete);
        sync_week(&mut profile, current_week(&env));
        profile.weekly_goal_minutes = new_goal_minutes;

        write_profile(&env, &athlete, &profile);
        WeeklyGoalUpdated {
            athlete,
            weekly_goal_minutes: new_goal_minutes,
        }
        .publish(&env);
    }

    pub fn log_workout(env: Env, athlete: Address, workout_type: String, minutes_spent: u32) {
        athlete.require_auth();
        validate_workout_type(&workout_type);
        validate_workout_minutes(minutes_spent);

        let mut profile = read_profile_required(&env, &athlete);
        sync_week(&mut profile, current_week(&env));

        let current_day = current_day(&env);
        if profile.session_count == 0 {
            profile.current_streak = 1;
        } else if current_day == profile.last_workout_day {
        } else if current_day == profile.last_workout_day + 1 {
            profile.current_streak += 1;
        } else {
            profile.current_streak = 1;
        }

        profile.last_workout_day = current_day;
        profile.total_minutes += minutes_spent;
        profile.minutes_this_week += minutes_spent;

        let workout = WorkoutSession {
            workout_type: workout_type.clone(),
            minutes_spent,
            timestamp: env.ledger().timestamp(),
            streak_after_log: profile.current_streak,
        };

        write_session(&env, &athlete, profile.session_count, &workout);
        profile.session_count += 1;
        write_profile(&env, &athlete, &profile);

        WorkoutLogged {
            athlete,
            workout_type,
            minutes_spent,
            minutes_this_week: profile.minutes_this_week,
            current_streak: profile.current_streak,
        }
        .publish(&env);
    }

    pub fn has_profile(env: Env, athlete: Address) -> bool {
        env.storage().persistent().has(&DataKey::Profile(athlete))
    }

    pub fn get_dashboard(env: Env, athlete: Address) -> Dashboard {
        let mut profile = read_profile_required(&env, &athlete);
        if current_week(&env) > profile.active_week {
            profile.minutes_this_week = 0;
        }

        Dashboard {
            display_name: profile.display_name,
            weekly_goal_minutes: profile.weekly_goal_minutes,
            total_minutes: profile.total_minutes,
            minutes_this_week: profile.minutes_this_week,
            session_count: profile.session_count,
            current_streak: profile.current_streak,
            created_at: profile.created_at,
            goal_reached_this_week: profile.minutes_this_week >= profile.weekly_goal_minutes,
        }
    }

    pub fn get_session_count(env: Env, athlete: Address) -> u32 {
        read_profile_optional(&env, &athlete)
            .map(|profile| profile.session_count)
            .unwrap_or(0)
    }

    pub fn get_session(env: Env, athlete: Address, index: u32) -> WorkoutSession {
        let count = Self::get_session_count(env.clone(), athlete.clone());
        assert!(index < count, "Session index out of bounds");

        env.storage()
            .persistent()
            .get(&DataKey::Session(athlete, index))
            .unwrap_or_else(|| panic!("Session not found"))
    }
}

fn read_profile_optional(env: &Env, athlete: &Address) -> Option<WorkoutProfile> {
    env.storage()
        .persistent()
        .get(&DataKey::Profile(athlete.clone()))
}

fn read_profile_required(env: &Env, athlete: &Address) -> WorkoutProfile {
    read_profile_optional(env, athlete).unwrap_or_else(|| panic!("Profile not found"))
}

fn write_profile(env: &Env, athlete: &Address, profile: &WorkoutProfile) {
    env.storage()
        .persistent()
        .set(&DataKey::Profile(athlete.clone()), profile);
}

fn write_session(env: &Env, athlete: &Address, index: u32, session: &WorkoutSession) {
    env.storage()
        .persistent()
        .set(&DataKey::Session(athlete.clone(), index), session);
}

fn sync_week(profile: &mut WorkoutProfile, current_week: u64) {
    if current_week > profile.active_week {
        profile.active_week = current_week;
        profile.minutes_this_week = 0;
    }
}

fn current_week(env: &Env) -> u64 {
    env.ledger().timestamp() / WEEK_IN_SECONDS
}

fn current_day(env: &Env) -> u64 {
    env.ledger().timestamp() / DAY_IN_SECONDS
}

fn validate_display_name(display_name: &String) {
    let length = display_name.len();
    assert!(length >= 3 && length <= 32, "Display name must be 3-32 chars");
}

fn validate_workout_type(workout_type: &String) {
    let length = workout_type.len();
    assert!(length >= 3 && length <= 48, "Workout type must be 3-48 chars");
}

fn validate_workout_minutes(minutes_spent: u32) {
    assert!(
        (MIN_WORKOUT_MINUTES..=MAX_WORKOUT_MINUTES).contains(&minutes_spent),
        "Workout minutes out of range"
    );
}

fn validate_weekly_goal(weekly_goal_minutes: u32) {
    assert!(
        (MIN_GOAL_MINUTES..=MAX_GOAL_MINUTES).contains(&weekly_goal_minutes),
        "Weekly goal out of range"
    );
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup() -> (Env, WorkoutForgeClient<'static>, Address) {
        let env = Env::default();
        let contract_id = env.register(WorkoutForge, ());
        let client = WorkoutForgeClient::new(&env, &contract_id);
        let athlete = Address::generate(&env);
        env.mock_all_auths();
        (env, client, athlete)
    }

    fn text(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    #[test]
    fn creates_profile_and_reads_dashboard() {
        let (env, client, athlete) = setup();

        client.save_profile(&athlete, &text(&env, "Iron Atlas"), &360);
        let dashboard = client.get_dashboard(&athlete);

        assert_eq!(dashboard.display_name, text(&env, "Iron Atlas"));
        assert_eq!(dashboard.weekly_goal_minutes, 360);
        assert_eq!(dashboard.total_minutes, 0);
        assert!(!dashboard.goal_reached_this_week);
    }

    #[test]
    fn logs_workouts_and_grows_streak_across_days() {
        let (env, client, athlete) = setup();

        client.save_profile(&athlete, &text(&env, "Circuit Queen"), &300);
        client.log_workout(&athlete, &text(&env, "Cardio"), &90);

        env.ledger().set_timestamp(DAY_IN_SECONDS + 90);
        client.log_workout(&athlete, &text(&env, "Upper Body"), &45);

        let dashboard = client.get_dashboard(&athlete);
        let session = client.get_session(&athlete, &1);

        assert_eq!(dashboard.total_minutes, 135);
        assert_eq!(dashboard.minutes_this_week, 135);
        assert_eq!(dashboard.session_count, 2);
        assert_eq!(dashboard.current_streak, 2);
        assert_eq!(session.workout_type, text(&env, "Upper Body"));
        assert_eq!(session.minutes_spent, 45);
    }

    #[test]
    fn resets_weekly_progress_after_boundary() {
        let (env, client, athlete) = setup();

        client.save_profile(&athlete, &text(&env, "Tempo Titan"), &240);
        client.log_workout(&athlete, &text(&env, "Mobility"), &120);

        env.ledger().set_timestamp(WEEK_IN_SECONDS + DAY_IN_SECONDS);
        let dashboard = client.get_dashboard(&athlete);

        assert_eq!(dashboard.minutes_this_week, 0);
        assert_eq!(dashboard.total_minutes, 120);
    }

    #[test]
    #[should_panic(expected = "Profile not found")]
    fn rejects_missing_profile_workout_logs() {
        let (env, client, athlete) = setup();
        client.log_workout(&athlete, &text(&env, "No profile yet"), &60);
    }

    #[test]
    #[should_panic(expected = "Display name must be 3-32 chars")]
    fn rejects_short_display_names() {
        let (env, client, athlete) = setup();
        client.save_profile(&athlete, &text(&env, "AB"), &200);
    }

    #[test]
    #[should_panic(expected = "Workout minutes out of range")]
    fn rejects_short_workouts() {
        let (env, client, athlete) = setup();
        client.save_profile(&athlete, &text(&env, "Lift Loop"), &200);
        client.log_workout(&athlete, &text(&env, "Yoga"), &4);
    }

    #[test]
    #[should_panic(expected = "Weekly goal out of range")]
    fn rejects_bad_goal_updates() {
        let (env, client, athlete) = setup();
        client.save_profile(&athlete, &text(&env, "Goal Guard"), &200);
        client.update_weekly_goal(&athlete, &20);
    }
}
