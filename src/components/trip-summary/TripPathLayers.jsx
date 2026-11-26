import { CircleMarker, Polyline, Popup } from "react-leaflet";
import { formatDateTime } from "./tripPath";

export default function TripPathLayers({ positions, startPoint, endPoint, activity }) {
  return (
    <>
      <Polyline
        positions={positions}
        pathOptions={{
          color: "#0f172a",
          weight: 7,
          opacity: 0.72,
        }}
      />
      <Polyline
        positions={positions}
        pathOptions={{
          color: "#60a5fa",
          weight: 4,
          opacity: 0.92,
        }}
      />
      {startPoint ? (
        <CircleMarker
          center={[startPoint.lat, startPoint.lon]}
          radius={7}
          pathOptions={{
            color: "#bbf7d0",
            fillColor: "#22c55e",
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Popup>
            <strong>{activity ? "First recorded location" : "Trip start"}</strong>
            <br />
            {formatDateTime(startPoint.seenAt)}
          </Popup>
        </CircleMarker>
      ) : null}
      {endPoint && endPoint !== startPoint ? (
        <CircleMarker
          center={[endPoint.lat, endPoint.lon]}
          radius={7}
          pathOptions={{
            color: "#fecaca",
            fillColor: "#ef4444",
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Popup>
            <strong>{activity ? "Last recorded location" : "Trip end"}</strong>
            <br />
            {formatDateTime(endPoint.seenAt)}
          </Popup>
        </CircleMarker>
      ) : null}
    </>
  );
}
