/**
 * Live danger awareness for voice: active incidents (camera-confirmed and operator-reported danger
 * zones) and a way out of the nearest zone. The host app supplies the data through
 * `globalThis.__sauronSafety` (see apps/web/src/iris-safety.ts); without it these tools report
 * unavailable. Voice-only: they read the open app's live state.
 */

import { defineTool, ToolError } from '../catalog.js';

const POSITION_SCHEMA = Object.freeze({
  latitude: Object.freeze({
    type: 'number', minimum: -90, maximum: 90,
    description: 'Where the person is, if they said so. Omit to use their device location (or the map view).',
  }),
  longitude: Object.freeze({ type: 'number', minimum: -180, maximum: 180 }),
});

function bridge() {
  const safety = globalThis.__sauronSafety;
  if (!safety || typeof safety.dangers !== 'function')
    throw new ToolError('unavailable', 'Live incident data is not connected in this app');
  return safety;
}

function positionArg(args) {
  return Number.isFinite(args.latitude) && Number.isFinite(args.longitude)
    ? { latitude: args.latitude, longitude: args.longitude }
    : undefined;
}

export const getActiveDangers = defineTool({
  name: 'get_active_dangers',
  title: 'Active dangers',
  description:
    'Every active dangerous event the alert system knows about: camera-confirmed fire or smoke, and events an ' +
    "operator marked by hand (fire, flood, gas leak, chemical, violence) with a danger-zone radius. Gives each one's " +
    'distance and direction from the person and whether they are inside its danger zone. Call this whenever someone ' +
    'asks about danger, alerts, or whether they are safe, and before giving any evacuation advice.',
  inputSchema: { type: 'object', properties: { ...POSITION_SCHEMA }, additionalProperties: false },
  async run(args) {
    const safety = bridge();
    const { position, source } = await safety.position(positionArg(args));
    const dangers = safety.dangers(position);
    const inside = dangers.filter((danger) => danger.insideDangerZone);
    return {
      summary: dangers.length
        ? `${dangers.length} active danger${dangers.length === 1 ? '' : 's'}` +
          (inside.length ? `; the person is INSIDE the zone of ${inside.map((d) => d.what).join(', ')}` : '')
        : 'No active dangers.',
      data: { person_position: position ?? null, position_source: source, dangers },
    };
  },
});

export const getEscapeRoute = defineTool({
  name: 'get_escape_route',
  title: 'Escape route',
  description:
    'How to get out of the nearest danger zone: the compass direction to head (straight away from the danger), a ' +
    'safe point 1 km past the edge of the zone, and the distance to it. Draws the way out on the map and flies there. ' +
    'Use this first when someone is in or near a danger zone. It is a direction, not turn-by-turn road directions: ' +
    'tell them to follow roads heading that way, never toward the danger, and to call 911 if they are in immediate danger.',
  inputSchema: { type: 'object', properties: { ...POSITION_SCHEMA }, additionalProperties: false },
  async run(args) {
    const safety = bridge();
    const { position, source } = await safety.position(positionArg(args));
    if (!position)
      throw new ToolError('unavailable', 'The person\'s location is unknown; ask where they are');
    const plan = safety.escape(position);
    if (!plan) return { summary: 'No active danger zone to escape.', data: { dangers: [] } };
    return {
      summary: `${plan.danger.insideDangerZone ? 'Inside' : 'Near'} ${plan.danger.what}: head ${plan.head}, ${plan.kmToSafety} km to a safe point.`,
      data: {
        person_position: position, position_source: source,
        danger: plan.danger, head: plan.head, safe_point: plan.safePoint, km_to_safety: plan.kmToSafety,
        drawn_on_map: plan.drawn === true,
      },
    };
  },
});
