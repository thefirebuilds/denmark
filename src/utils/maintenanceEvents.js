export const MAINTENANCE_TASKS_UPDATED_EVENT = "denmark:maintenance-tasks-updated";

export function notifyMaintenanceTasksUpdated(detail = {}) {
  window.dispatchEvent(
    new CustomEvent(MAINTENANCE_TASKS_UPDATED_EVENT, {
      detail,
    })
  );
}
