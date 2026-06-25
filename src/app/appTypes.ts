export type UnknownRecord = Record<string, unknown>;

export type TripLike = UnknownRecord & {
  id?: string | number | null;
};

export type EditTripRequest = {
  tripId: string | number;
  requestedAt: number;
} | null;
