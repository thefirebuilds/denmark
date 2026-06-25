export const DEFAULT_DISPATCH_SETTINGS = {
  openTripsSort: "priority",
  pinOverdue: true,
  showCanceled: false,
  visibleBuckets: {
    needs_closeout: true,
    in_progress: true,
    unconfirmed: true,
    upcoming: true,
    canceled: false,
    closed: false,
  },
  bucketOrder: [
    "needs_closeout",
    "in_progress",
    "unconfirmed",
    "upcoming",
    "canceled",
    "closed",
  ],
};

export function mergeDispatchSettings(settings: unknown) {
  const values =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)
      : {};
  const savedVisibleBuckets =
    values.visibleBuckets && typeof values.visibleBuckets === "object"
      ? (values.visibleBuckets as Record<string, boolean>)
      : {};
  const visibleBuckets = {
    ...DEFAULT_DISPATCH_SETTINGS.visibleBuckets,
    ...savedVisibleBuckets,
  };

  if (!values.visibleBuckets && values.showCanceled !== undefined) {
    visibleBuckets.canceled = Boolean(values.showCanceled);
  }

  return {
    ...DEFAULT_DISPATCH_SETTINGS,
    ...values,
    visibleBuckets,
    showCanceled: Boolean(visibleBuckets.canceled),
    bucketOrder:
      Array.isArray(values.bucketOrder) && values.bucketOrder.length
        ? values.bucketOrder
        : DEFAULT_DISPATCH_SETTINGS.bucketOrder,
  };
}
