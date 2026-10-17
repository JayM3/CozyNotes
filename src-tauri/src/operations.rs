use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Trash,
    Exit,
}

#[derive(Clone, Debug)]
pub struct Preparation {
    pub operation_id: String,
    pub kind: OperationKind,
    pub window_labels: Vec<String>,
}

#[derive(Clone, Default)]
pub struct OperationCoordinator {
    inner: Arc<(Mutex<Option<PendingOperation>>, Condvar)>,
}

struct PendingOperation {
    preparation: Preparation,
    acknowledgments: HashMap<String, Option<bool>>,
}

impl OperationCoordinator {
    pub fn busy(&self) -> bool {
        self.inner
            .0
            .lock()
            .map(|state| state.is_some())
            .unwrap_or(true)
    }

    pub fn allows_save(&self, window_label: &str, target_label: &str) -> bool {
        self.inner
            .0
            .lock()
            .map(|state| match state.as_ref() {
                None => true,
                Some(pending) => match pending.acknowledgments.get(target_label) {
                    None => true,
                    Some(ack) => window_label == target_label && ack.is_none(),
                },
            })
            .unwrap_or(false)
    }

    pub fn begin(
        &self,
        kind: OperationKind,
        window_labels: Vec<String>,
    ) -> Result<Preparation, String> {
        let mut state = self
            .inner
            .0
            .lock()
            .map_err(|_| "Operation coordinator is unavailable".to_string())?;
        if state.is_some() {
            return Err("Another operation is in progress".into());
        }
        let mut acknowledgments = HashMap::with_capacity(window_labels.len());
        for label in &window_labels {
            acknowledgments.insert(label.clone(), None);
        }
        let preparation = Preparation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            kind,
            window_labels,
        };
        *state = Some(PendingOperation {
            preparation: preparation.clone(),
            acknowledgments,
        });
        self.inner.1.notify_all();
        Ok(preparation)
    }

    pub fn is_active(&self, operation_id: &str, window_label: &str) -> bool {
        self.inner
            .0
            .lock()
            .ok()
            .and_then(|state| {
                state.as_ref().map(|pending| {
                    pending.preparation.operation_id == operation_id
                        && pending.acknowledgments.contains_key(window_label)
                })
            })
            .unwrap_or(false)
    }

    pub fn acknowledge(
        &self,
        window_label: &str,
        operation_id: &str,
        success: bool,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .0
            .lock()
            .map_err(|_| "Operation coordinator is unavailable".to_string())?;
        let pending = state
            .as_mut()
            .filter(|pending| pending.preparation.operation_id == operation_id)
            .ok_or_else(|| "No matching editor operation is pending".to_string())?;
        let acknowledgment = pending
            .acknowledgments
            .get_mut(window_label)
            .ok_or_else(|| "Unexpected editor acknowledgment".to_string())?;
        if acknowledgment.is_some() {
            return Err("Duplicate editor acknowledgment".into());
        }
        *acknowledgment = Some(success);
        self.inner.1.notify_all();
        Ok(())
    }

    pub async fn wait_for_preparation_with_timeout(
        &self,
        preparation: Preparation,
        timeout: Duration,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn_blocking(move || {
            let deadline = Instant::now() + timeout;
            let (mutex, changed) = &*inner;
            let mut state = mutex
                .lock()
                .map_err(|_| "Operation coordinator is unavailable".to_string())?;
            loop {
                let pending = state
                    .as_ref()
                    .filter(|pending| pending.preparation.operation_id == preparation.operation_id)
                    .ok_or_else(|| "No matching editor operation is pending".to_string())?;
                if pending
                    .acknowledgments
                    .values()
                    .any(|ack| *ack == Some(false))
                {
                    return Err("An editor failed to save".into());
                }
                if pending
                    .acknowledgments
                    .values()
                    .all(|ack| *ack == Some(true))
                {
                    return Ok(());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("An editor failed to save or did not respond".into());
                }
                let (next_state, wait) = changed
                    .wait_timeout(state, remaining)
                    .map_err(|_| "Operation coordinator is unavailable".to_string())?;
                state = next_state;
                if wait.timed_out() {
                    return Err("An editor failed to save or did not respond".into());
                }
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub fn finish(&self, operation_id: &str) -> Result<Preparation, String> {
        let mut state = self
            .inner
            .0
            .lock()
            .map_err(|_| "Operation coordinator is unavailable".to_string())?;
        let pending = state
            .as_ref()
            .filter(|pending| pending.preparation.operation_id == operation_id)
            .ok_or_else(|| "No matching editor operation is pending".to_string())?;
        let preparation = pending.preparation.clone();
        *state = None;
        self.inner.1.notify_all();
        Ok(preparation)
    }

    pub fn cancel(&self, operation_id: &str) -> Result<Preparation, String> {
        self.finish(operation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn preparation_blocks_conflicts_but_allows_the_expected_editors_final_save() {
        let coordinator = OperationCoordinator::default();
        assert!(!coordinator.busy());
        let preparation = coordinator
            .begin(OperationKind::Trash, vec!["note-one".into()])
            .unwrap();
        assert!(coordinator.busy());
        assert!(coordinator.allows_save("note-one", "note-one"));
        assert!(!coordinator.allows_save("library", "note-one"));
        assert!(coordinator.allows_save("note-two", "note-two"));
        assert!(coordinator.begin(OperationKind::Exit, vec![]).is_err());
        coordinator
            .acknowledge("note-one", &preparation.operation_id, true)
            .unwrap();
        assert!(!coordinator.allows_save("note-one", "note-one"));
        coordinator.finish(&preparation.operation_id).unwrap();
        assert!(!coordinator.busy());
        assert!(coordinator.allows_save("note-one", "note-one"));
    }

    #[test]
    fn acknowledgments_are_correlated_to_expected_windows_and_operation_ids() {
        let coordinator = OperationCoordinator::default();
        let preparation = coordinator
            .begin(
                OperationKind::Trash,
                vec!["note-one".into(), "note-two".into()],
            )
            .unwrap();
        assert!(coordinator.is_active(&preparation.operation_id, "note-one"));
        assert!(
            coordinator
                .acknowledge("note-one", &preparation.operation_id, true)
                .is_ok()
        );
        assert!(
            coordinator
                .acknowledge("note-one", &preparation.operation_id, true)
                .unwrap_err()
                .contains("Duplicate")
        );
        assert!(
            coordinator
                .acknowledge("note-three", &preparation.operation_id, true)
                .unwrap_err()
                .contains("Unexpected")
        );
        assert!(
            coordinator
                .acknowledge("note-two", "00000000-0000-4000-8000-000000000000", true)
                .unwrap_err()
                .contains("No matching")
        );
        coordinator
            .acknowledge("note-two", &preparation.operation_id, true)
            .unwrap();
        tauri::async_runtime::block_on(
            coordinator.wait_for_preparation_with_timeout(preparation, Duration::from_millis(50)),
        )
        .unwrap();
    }

    #[test]
    fn failed_acknowledgment_and_timeout_cancel_without_staying_active() {
        let coordinator = OperationCoordinator::default();
        let preparation = coordinator
            .begin(OperationKind::Exit, vec!["note-one".into()])
            .unwrap();
        coordinator
            .acknowledge("note-one", &preparation.operation_id, false)
            .unwrap();
        let operation_id = preparation.operation_id.clone();
        let error = tauri::async_runtime::block_on(
            coordinator.wait_for_preparation_with_timeout(preparation, Duration::from_millis(50)),
        )
        .unwrap_err();
        assert!(error.contains("failed"));
        coordinator.cancel(&operation_id).unwrap();
        assert!(!coordinator.is_active(&operation_id, "note-one"));

        let timeout = coordinator
            .begin(OperationKind::Exit, vec!["note-two".into()])
            .unwrap();
        let timeout_id = timeout.operation_id.clone();
        let error = tauri::async_runtime::block_on(
            coordinator.wait_for_preparation_with_timeout(timeout, Duration::from_millis(1)),
        )
        .unwrap_err();
        assert!(error.contains("respond"));
        coordinator.cancel(&timeout_id).unwrap();
    }
}
