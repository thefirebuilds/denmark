// Explicitly identified by the operator as outside Denmark's fleet. Provider
// account access, active flags and an accidental listing ID cannot override it.
const NON_OWNED_NAMES = Object.freeze(['blossom', 'cocaina', 'oj', 'phantom', 'tulip', 'yogi']);
const names = new Set(NON_OWNED_NAMES);
function isNonOwnedVehicle(vehicle) {
  return [vehicle?.nickname, vehicle?.turo_vehicle_name, ...(Array.isArray(vehicle?.aliases) ? vehicle.aliases : [])]
    .some(name => names.has(String(name || '').trim().toLowerCase()));
}
module.exports = { NON_OWNED_NAMES, isNonOwnedVehicle };
