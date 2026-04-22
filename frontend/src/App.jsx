import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WatchWalletChanges } from "@stellar/freighter-api";
import {
  configuredContractId,
  configuredNetworkPassphrase,
  connectWallet,
  discoverWalletState,
  formatDate,
  formatMinutes,
  getExplorerLink,
  getNetworkLabel,
  hasContractConfig,
  logWorkout,
  parseError,
  readDashboard,
  readRecentWorkouts,
  saveProfile,
  shortAddress,
  updateWeeklyGoal
} from "./lib/workoutForge";

const emptyWallet = {
  account: "",
  network: "",
  networkPassphrase: "",
  rpcUrl: "",
  isConnecting: false,
  error: ""
};

const emptyTx = {
  status: "idle",
  message: "",
  hash: ""
};

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function Panel({ eyebrow, title, body, children, tone = "energy" }) {
  return (
    <section className={`panel panel-${tone}`}>
      <div className="panel-head">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {body ? <p className="panel-body">{body}</p> : null}
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value, note, loading = false }) {
  return (
    <article className="metric-card">
      <p className="metric-label">{label}</p>
      <div className={loading ? "skeleton skeleton-metric" : "metric-value"}>
        {loading ? "" : value}
      </div>
      <p className="metric-note">{loading ? <span className="skeleton skeleton-note" /> : note}</p>
    </article>
  );
}

function ActivitySkeleton() {
  return (
    <div className="session-list">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="session-card session-skeleton" key={index}>
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-note" />
          <span className="skeleton skeleton-badge" />
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [wallet, setWallet] = useState(emptyWallet);
  const [txState, setTxState] = useState(emptyTx);
  const [profileForm, setProfileForm] = useState({
    displayName: "",
    weeklyGoalMinutes: "240"
  });
  const [goalForm, setGoalForm] = useState("300");
  const [workoutForm, setWorkoutForm] = useState({
    workoutType: "",
    minutesSpent: "45"
  });

  useEffect(() => {
    let isMounted = true;
    let watcher = null;

    async function syncWallet() {
      try {
        const nextState = await discoverWalletState();
        if (!isMounted) {
          return;
        }

        setWallet((current) => ({
          ...current,
          ...nextState,
          isConnecting: false,
          error: ""
        }));
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setWallet((current) => ({
          ...current,
          isConnecting: false,
          error: parseError(error)
        }));
      }
    }

    syncWallet();

    if (typeof window !== "undefined") {
      watcher = new WatchWalletChanges(3000);
      watcher.watch(() => {
        setTxState(emptyTx);
        syncWallet();
      });
    }

    return () => {
      isMounted = false;
      watcher?.stop?.();
    };
  }, []);

  const wrongNetwork =
    Boolean(wallet.networkPassphrase) && wallet.networkPassphrase !== configuredNetworkPassphrase;
  const readyForReads = Boolean(wallet.account) && hasContractConfig() && !wrongNetwork;

  const dashboardQuery = useQuery({
    queryKey: ["dashboard", wallet.account, wallet.networkPassphrase],
    queryFn: () => readDashboard(wallet.account),
    enabled: readyForReads
  });

  const workoutsQuery = useQuery({
    queryKey: ["workouts", wallet.account, wallet.networkPassphrase, dashboardQuery.data?.sessionCount || 0],
    queryFn: () => readRecentWorkouts(wallet.account, 5),
    enabled: readyForReads && Boolean(dashboardQuery.data)
  });

  useEffect(() => {
    if (!dashboardQuery.data) {
      return;
    }

    setGoalForm(String(dashboardQuery.data.weeklyGoalMinutes));
    setProfileForm((current) => ({
      displayName: current.displayName || dashboardQuery.data.displayName,
      weeklyGoalMinutes: current.weeklyGoalMinutes || String(dashboardQuery.data.weeklyGoalMinutes)
    }));
  }, [dashboardQuery.data]);

  const dashboard = dashboardQuery.data;
  const weeklyProgress = useMemo(() => {
    if (!dashboard?.weeklyGoalMinutes) {
      return 0;
    }

    return Math.min(
      100,
      Math.round((dashboard.minutesThisWeek / dashboard.weeklyGoalMinutes) * 100)
    );
  }, [dashboard]);

  async function runLedgerAction(action, pendingMessage, successMessage) {
    if (!wallet.account) {
      throw new Error("Connect Freighter before sending a transaction.");
    }

    if (wrongNetwork) {
      throw new Error(`Switch Freighter to ${getNetworkLabel(configuredNetworkPassphrase)}.`);
    }

    setTxState({
      status: "pending",
      message: pendingMessage,
      hash: ""
    });

    try {
      const result = await action();

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard", wallet.account] }),
        queryClient.invalidateQueries({ queryKey: ["workouts", wallet.account] })
      ]);

      setTxState({
        status: "success",
        message: successMessage,
        hash: result.hash
      });
    } catch (error) {
      const message = parseError(error);
      setTxState({
        status: "error",
        message,
        hash: ""
      });
      throw error;
    }
  }

  const saveProfileMutation = useMutation({
    mutationFn: ({ displayName, weeklyGoalMinutes }) =>
      runLedgerAction(
        () => saveProfile(wallet.account, displayName, weeklyGoalMinutes),
        "Building your athlete profile on Stellar...",
        "Profile saved on Soroban."
      )
  });

  const updateGoalMutation = useMutation({
    mutationFn: ({ weeklyGoalMinutes }) =>
      runLedgerAction(
        () => updateWeeklyGoal(wallet.account, weeklyGoalMinutes),
        "Updating your weekly workout target...",
        "Weekly goal updated."
      )
  });

  const logWorkoutMutation = useMutation({
    mutationFn: ({ workoutType, minutesSpent }) =>
      runLedgerAction(
        () => logWorkout(wallet.account, workoutType, minutesSpent),
        "Writing your workout session to Stellar...",
        "Workout logged."
      )
  });

  const anyMutationPending =
    saveProfileMutation.isPending || updateGoalMutation.isPending || logWorkoutMutation.isPending;

  async function handleConnectWallet() {
    setWallet((current) => ({
      ...current,
      isConnecting: true,
      error: ""
    }));

    try {
      const nextState = await connectWallet();
      setWallet({
        ...emptyWallet,
        ...nextState,
        isConnecting: false
      });
    } catch (error) {
      setWallet((current) => ({
        ...current,
        isConnecting: false,
        error: parseError(error)
      }));
    }
  }

  function handleProfileSubmit(event) {
    event.preventDefault();

    const displayName = profileForm.displayName.trim();
    const weeklyGoalMinutes = Number(profileForm.weeklyGoalMinutes);

    if (!displayName) {
      setTxState({
        status: "error",
        message: "Add an athlete name before saving your profile.",
        hash: ""
      });
      return;
    }

    if (Number.isNaN(weeklyGoalMinutes) || weeklyGoalMinutes < 30 || weeklyGoalMinutes > 5000) {
      setTxState({
        status: "error",
        message: "Weekly goal must stay between 30 and 5000 minutes.",
        hash: ""
      });
      return;
    }

    saveProfileMutation.mutate({
      displayName,
      weeklyGoalMinutes
    });
  }

  function handleGoalSubmit(event) {
    event.preventDefault();

    const weeklyGoalMinutes = Number(goalForm);
    if (Number.isNaN(weeklyGoalMinutes) || weeklyGoalMinutes < 30 || weeklyGoalMinutes > 5000) {
      setTxState({
        status: "error",
        message: "Pick a weekly workout target between 30 and 5000 minutes.",
        hash: ""
      });
      return;
    }

    updateGoalMutation.mutate({
      weeklyGoalMinutes
    });
  }

  function handleWorkoutSubmit(event) {
    event.preventDefault();

    const workoutType = workoutForm.workoutType.trim();
    const minutesSpent = Number(workoutForm.minutesSpent);

    if (!workoutType) {
      setTxState({
        status: "error",
        message: "Add a workout type so your on-chain training log stays meaningful.",
        hash: ""
      });
      return;
    }

    if (Number.isNaN(minutesSpent) || minutesSpent < 5 || minutesSpent > 480) {
      setTxState({
        status: "error",
        message: "Workout sessions must be between 5 and 480 minutes.",
        hash: ""
      });
      return;
    }

    logWorkoutMutation.mutate({
      workoutType,
      minutesSpent
    });
  }

  const txExplorerLink = getExplorerLink(wallet.networkPassphrase, txState.hash);

  return (
    <div className="app-shell">
      <div className="glow glow-one" />
      <div className="glow glow-two" />
      <div className="glow glow-three" />

      <header className="hero">
        <div className="hero-main">
          <div className="brand-row">
            <BrandMark />
            <div>
              <p className="kicker">On-chain workout consistency tracker</p>
              <h1>WorkoutForge</h1>
            </div>
          </div>

          <p className="lead">
            Track your weekly training on Stellar with a wallet-backed athlete profile, live
            workout streaks, and an auditable session ledger built for cardio, strength, yoga,
            mobility, and every routine in between.
          </p>

          <div className="hero-actions">
            <button
              className="button button-primary"
              onClick={handleConnectWallet}
              disabled={wallet.isConnecting}
            >
              {wallet.isConnecting
                ? "Connecting..."
                : wallet.account
                  ? "Wallet Connected"
                  : "Connect Freighter"}
            </button>
            <div className="hero-badges">
              <span className="pill">Soroban powered</span>
              <span className="pill">Athlete ledger</span>
              <span className="pill">Workout streaks</span>
            </div>
          </div>
        </div>

        <div className="hero-side">
          <div className="hero-side-top">
            <div>
              <p className="side-label">Athlete</p>
              <strong>{wallet.account ? shortAddress(wallet.account) : "Wallet not connected"}</strong>
            </div>
            <div>
              <p className="side-label">Network</p>
              <strong>
                {wallet.networkPassphrase
                  ? getNetworkLabel(wallet.networkPassphrase)
                  : "Awaiting Freighter"}
              </strong>
            </div>
          </div>

          <div className="hero-side-stat">
            <span>Contract</span>
            <strong>{configuredContractId ? shortAddress(configuredContractId) : "Not deployed"}</strong>
          </div>

          <div className="progress-shell">
            <div className="progress-labels">
              <span>Weekly workout goal</span>
              <span>{dashboard ? `${weeklyProgress}%` : "0%"}</span>
            </div>
            <div className="progress-track">
              <span className="progress-fill" style={{ width: `${weeklyProgress}%` }} />
            </div>
          </div>

          <p className="hero-note">
            Keep your training momentum visible with wallet-based actions, on-chain workout logs,
            and a simple dashboard that rewards consistency.
          </p>
        </div>
      </header>

      <section className="status-banner">
        <div>
          <p className="status-label">Live status</p>
          <p className="status-copy">
            {wallet.error ||
              (wrongNetwork
                ? `Connected to ${getNetworkLabel(wallet.networkPassphrase)}. Switch Freighter to ${getNetworkLabel(configuredNetworkPassphrase)}.`
                : txState.message ||
                  (hasContractConfig()
                    ? "Ready to read and write workout sessions on Stellar."
                    : "Deploy the WorkoutForge contract and export the frontend config before using the app."))}
          </p>
        </div>
        {txExplorerLink ? (
          <a className="status-link" href={txExplorerLink} target="_blank" rel="noreferrer">
            View transaction
          </a>
        ) : null}
      </section>

      <section className="metrics-grid">
        <MetricCard
          label="Workout logged"
          value={dashboard ? formatMinutes(dashboard.totalMinutes) : "0m"}
          note={dashboard ? `${dashboard.sessionCount} chain-recorded sessions` : "Starts after your first workout"}
          loading={dashboardQuery.isLoading}
        />
        <MetricCard
          label="This week"
          value={dashboard ? formatMinutes(dashboard.minutesThisWeek) : "0m"}
          note={
            dashboard
              ? `${Math.max(dashboard.weeklyGoalMinutes - dashboard.minutesThisWeek, 0)} minutes left to goal`
              : "Set your weekly workout target"
          }
          loading={dashboardQuery.isLoading}
        />
        <MetricCard
          label="Fitness streak"
          value={
            dashboard
              ? `${dashboard.currentStreak} day${dashboard.currentStreak === 1 ? "" : "s"}`
              : "0 days"
          }
          note={
            dashboard
              ? dashboard.goalReachedThisWeek
                ? "Weekly target already cleared"
                : "Log today to keep it alive"
              : "Consecutive-day workout tracker"
          }
          loading={dashboardQuery.isLoading}
        />
        <MetricCard
          label="Athlete tag"
          value={dashboard?.displayName || "No profile"}
          note={wallet.account ? shortAddress(wallet.account) : "Connect to personalize"}
          loading={dashboardQuery.isLoading}
        />
      </section>

      {!hasContractConfig() ? (
        <Panel
          eyebrow="Deployment runway"
          title="Deploy WorkoutForge and wire the live app"
          body="Build the Rust contract, deploy with Stellar CLI, and export the new contract ID so the frontend can log workout data against its own on-chain ledger."
          tone="recovery"
        >
          <div className="code-stack">
            <code>stellar keys generate alice --network testnet --fund</code>
            <code>npm run contract:build</code>
            <code>npm run contract:deploy</code>
            <code>npm run export:frontend</code>
          </div>
        </Panel>
      ) : null}

      <section className="panel-grid">
        <Panel
          eyebrow="Athlete setup"
          title="Create or refresh your training identity"
          body="Save a public athlete name and the number of workout minutes you want to hit every week."
          tone="energy"
        >
          <form className="form-grid" onSubmit={handleProfileSubmit}>
            <label>
              <span>Display name</span>
              <input
                type="text"
                placeholder="Iron Atlas"
                value={profileForm.displayName}
                onChange={(event) =>
                  setProfileForm((current) => ({ ...current, displayName: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Weekly goal (minutes)</span>
              <input
                type="number"
                min="30"
                max="5000"
                step="5"
                value={profileForm.weeklyGoalMinutes}
                onChange={(event) =>
                  setProfileForm((current) => ({
                    ...current,
                    weeklyGoalMinutes: event.target.value
                  }))
                }
              />
            </label>
            <button
              className="button button-primary"
              type="submit"
              disabled={anyMutationPending || !wallet.account || !hasContractConfig()}
            >
              {saveProfileMutation.isPending ? "Saving..." : "Save profile"}
            </button>
          </form>
        </Panel>

        <Panel
          eyebrow="Goal control"
          title="Retune your weekly training target"
          body="Adjust your workout-minute target whenever your routine changes. Weekly progress still resets on the next on-chain week."
          tone="recovery"
        >
          <form className="form-grid" onSubmit={handleGoalSubmit}>
            <label>
              <span>New weekly goal</span>
              <input
                type="number"
                min="30"
                max="5000"
                step="5"
                value={goalForm}
                onChange={(event) => setGoalForm(event.target.value)}
              />
            </label>
            <button
              className="button button-secondary"
              type="submit"
              disabled={anyMutationPending || !wallet.account || !dashboard || !hasContractConfig()}
            >
              {updateGoalMutation.isPending ? "Updating..." : "Update goal"}
            </button>
          </form>
        </Panel>

        <Panel
          eyebrow="Workout log"
          title="Record a training block"
          body="Capture workout type, duration, and streak impact. The activity feed refreshes after every confirmed Soroban write."
          tone="intensity"
        >
          <form className="form-grid" onSubmit={handleWorkoutSubmit}>
            <label>
              <span>Workout type</span>
              <input
                type="text"
                placeholder="Cardio, Chest, Yoga"
                value={workoutForm.workoutType}
                onChange={(event) =>
                  setWorkoutForm((current) => ({ ...current, workoutType: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Minutes trained</span>
              <input
                type="number"
                min="5"
                max="480"
                step="5"
                value={workoutForm.minutesSpent}
                onChange={(event) =>
                  setWorkoutForm((current) => ({
                    ...current,
                    minutesSpent: event.target.value
                  }))
                }
              />
            </label>
            <button
              className="button button-primary"
              type="submit"
              disabled={anyMutationPending || !wallet.account || !dashboard || !hasContractConfig()}
            >
              {logWorkoutMutation.isPending ? "Logging..." : "Log workout"}
            </button>
          </form>
        </Panel>
      </section>

      <section className="panel-grid panel-grid-bottom">
        <Panel
          eyebrow="Workout feed"
          title="Recent chain-confirmed sessions"
          body="The latest five workouts are read directly from the deployed contract for the connected wallet."
          tone="intensity"
        >
          {workoutsQuery.isLoading ? (
            <ActivitySkeleton />
          ) : workoutsQuery.data?.length ? (
            <div className="session-list">
              {workoutsQuery.data.map((workout) => (
                <article className="session-card" key={workout.id}>
                  <div>
                    <h3>{workout.workoutType}</h3>
                    <p>{formatDate(workout.timestamp)}</p>
                  </div>
                  <div className="session-meta">
                    <span>{formatMinutes(workout.minutesSpent)}</span>
                    <span>Streak {workout.streakAfterLog}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">
              {dashboard
                ? "Your workout feed will populate after the first logged session."
                : "Create a profile first, then your recent workouts will appear here."}
            </p>
          )}
        </Panel>

        <Panel
          eyebrow="Platform overview"
          title="How WorkoutForge works"
          body="WorkoutForge combines Freighter wallet access, Soroban contract writes, and a clean training dashboard for tracking on-chain workout consistency."
          tone="recovery"
        >
          <ul className="check-list">
            <li>Connect a Freighter wallet on Stellar Testnet</li>
            <li>Create an athlete profile and set a weekly workout goal</li>
            <li>Log cardio, strength, yoga, mobility, or custom sessions on-chain</li>
            <li>Track workout totals, weekly progress, and active streak momentum</li>
          </ul>
        </Panel>
      </section>
    </div>
  );
}
