"use client";

import { useEffect, useRef, useState } from "react";

interface Order {
  order_id: string;
  location_name: string;
  lat: number;
  lng: number;
  area_type: string;
  priority: string;
  weight_kg: number;
  deadline_hours: number;
  attempt_count?: number;
  item_category?: string;
}

interface Assignment {
  vehicle_id: string;
  vehicle_type: string;
  driver: string;
  assigned_order_ids: string[];
  route_sequence: string[];
  reasoning: string;
  total_weight_kg: number;
  capacity_kg: number;
  estimated_co2_kg: number;
  high_priority_count: number;
  flagged_orders: { order_id: string; flag: string; recommendation: string }[];
}

interface AlertItem {
  order_id: string;
  severity: string;
  message: string;
  corrective_action: string;
  area: string;
}

interface MapProps {
  orders: Order[];
  assignments: Assignment[];
  warehouse: { lat: number; lng: number; name: string };
  alerts: AlertItem[];
  injectedOrderId?: string | null;
  overriddenOrderIds?: string[];
  activeTab?: string; // "routes" | "forecast" | "alerts" | "analytics" | "arbitration"
}

const VEHICLE_COLORS: Record<string, string> = {
  electric: "#00e5ff",
  electric_bike: "#ff6b9d",
  diesel: "#ffd166",
  unknown: "#a78bfa",
};

const VEHICLE_LABELS: Record<string, string> = {
  electric: "EV",
  electric_bike: "BIKE",
  diesel: "TRUCK",
  unknown: "VEH",
};

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export default function DeliveryMap({
  orders,
  assignments,
  warehouse,
  alerts,
  injectedOrderId,
  overriddenOrderIds = [],
  activeTab = "routes",
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersLayerRef = useRef<any>(null);
  const routesLayerRef = useRef<any>(null);
  const vehicleLayerRef = useRef<any>(null);
  const animRefs = useRef<any[]>([]);
  const leafletRef = useRef<any>(null);
  const injectedLayerRef = useRef<any>(null);
  const mapReadyRef = useRef(false);

  const [selectedOrder, setSelectedOrder] = useState<{
    order: Order;
    assignment: Assignment | null;
    alert: AlertItem | null;
  } | null>(null);

  // Lookup maps
  const orderMap: Record<string, Order> = {};
  orders.forEach((o) => (orderMap[o.order_id] = o));

  const orderAssignmentMap: Record<string, Assignment> = {};
  assignments.forEach((a) => {
    (a.assigned_order_ids || []).forEach((oid) => {
      orderAssignmentMap[oid] = a;
    });
  });

  const alertMap: Record<string, AlertItem> = {};
  (alerts || []).forEach((a) => (alertMap[a.order_id] = a));

  // ── Init map ONCE ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapReadyRef.current) return;

    import("leaflet").then((L) => {
      if (mapReadyRef.current) return;
      mapReadyRef.current = true;
      leafletRef.current = L;

      delete (L.Icon.Default.prototype as any)._getIconUrl;

      const map = L.map(mapRef.current!, {
        center: [12.97, 77.59],
        zoom: 11,
        zoomControl: true,
        attributionControl: false,
      });
      mapInstanceRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
      }).addTo(map);

      // Warehouse marker
      const whIcon = L.divIcon({
        html: `<div style="
          width:48px;height:48px;border-radius:12px;
          background:linear-gradient(135deg,#00e5ff,#ff6b9d);
          display:flex;align-items:center;justify-content:center;
          font-size:22px;font-weight:bold;color:#030b18;
          border:3px solid rgba(255,255,255,0.5);
          box-shadow:0 0 20px rgba(0,229,255,0.8),0 0 40px rgba(0,229,255,0.4);
          animation:whpulse 2s ease-in-out infinite;">⬡</div>`,
        className: "",
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });
      L.marker([warehouse.lat, warehouse.lng], { icon: whIcon })
        .addTo(map)
        .bindTooltip("<b>ADA Central Warehouse</b>", { className: "map-tt" });

      // Legend
      const legend = (L.control as any)({ position: "bottomleft" });
      legend.onAdd = () => {
        const div = L.DomUtil.create("div");
        div.innerHTML = `<div style="
          background:#0a1628ee;backdrop-filter:blur(10px);
          border:1px solid #1e3a5a;border-radius:10px;
          padding:12px 16px;font-family:monospace;
          font-size:11px;color:#8ab0d0;min-width:160px;">
          <div style="color:#00e5ff;letter-spacing:2px;margin-bottom:10px;font-size:10px;">FLEET LEGEND</div>
          <div style="margin-bottom:5px;">⚡ <span style="color:#00e5ff">EV · Urban</span></div>
          <div style="margin-bottom:5px;">🛵 <span style="color:#ff6b9d">E-Bike</span></div>
          <div style="margin-bottom:5px;">🚛 <span style="color:#ffd166">Diesel · Rural</span></div>
          <div style="margin-bottom:5px;">⚠ <span style="color:#ff4d6d">High Alert</span></div>
          <div style="margin-top:8px;color:#2a4060;font-size:9px;">Click any pin for details</div>
        </div>`;
        return div;
      };
      legend.addTo(map);

      // Create layer groups
      markersLayerRef.current = L.layerGroup().addTo(map);
      routesLayerRef.current = L.layerGroup().addTo(map);
      vehicleLayerRef.current = L.layerGroup().addTo(map);

      // Draw initial content
      drawMapContent(L, map);
    });

    return () => {
      animRefs.current.forEach((id) => { cancelAnimationFrame(id); clearTimeout(id); });
      animRefs.current = [];
      if (mapInstanceRef.current) {
        try { mapInstanceRef.current.remove(); } catch (_) {}
        mapInstanceRef.current = null;
        mapReadyRef.current = false;
      }
    };
  }, []);

  // ── Redraw when tab or data changes ────────────────────────────────────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapInstanceRef.current || !leafletRef.current) return;
    drawMapContent(leafletRef.current, mapInstanceRef.current);
  }, [activeTab, assignments, orders, alerts]);

  // ── Core draw function ──────────────────────────────────────────────────────
  function drawMapContent(L: any, map: any) {
    // Clear existing layers
    if (markersLayerRef.current) markersLayerRef.current.clearLayers();
    if (routesLayerRef.current) routesLayerRef.current.clearLayers();
    if (vehicleLayerRef.current) vehicleLayerRef.current.clearLayers();

    // Cancel animations
    animRefs.current.forEach((id) => { cancelAnimationFrame(id); clearTimeout(id); });
    animRefs.current = [];

    if (activeTab === "routes") {
      drawRoutes(L, map);
      drawOrderMarkers(L, map, "all");
      setTimeout(() => startVehicleAnimation(L, map), 800);
    } else if (activeTab === "alerts") {
      drawAlertMarkers(L, map);
    } else if (activeTab === "forecast") {
      drawForecastMarkers(L, map);
    } else if (activeTab === "analytics") {
      drawAnalyticsMarkers(L, map);
    } else if (activeTab === "arbitration") {
      drawArbitrationMarkers(L, map);
    } else {
      // fallback — show all
      drawRoutes(L, map);
      drawOrderMarkers(L, map, "all");
      setTimeout(() => startVehicleAnimation(L, map), 800);
    }
  }


  // ── Routes tab: lines + vehicles ───────────────────────────────────────────
  function drawRoutes(L: any, map: any) {
    assignments.forEach((a) => {
      const color = VEHICLE_COLORS[a.vehicle_type] || "#ffd166";
      const stops: [number, number][] = [[warehouse.lat, warehouse.lng]];
      (a.assigned_order_ids || []).forEach((oid) => {
        const o = orderMap[oid];
        if (o) stops.push([o.lat, o.lng]);
      });
      stops.push([warehouse.lat, warehouse.lng]);
      if (stops.length < 2) return;

      routesLayerRef.current.addLayer(
        L.polyline(stops, { color, weight: 6, opacity: 0.06 })
      );
      routesLayerRef.current.addLayer(
        L.polyline(stops, {
          color,
          weight: 2,
          opacity: 0.55,
          dashArray: a.vehicle_type === "diesel" ? "8 5" : undefined,
        })
      );
    });
  }

  // ── Order markers (generic) ─────────────────────────────────────────────────
  function drawOrderMarkers(L: any, map: any, mode: string) {
    orders.forEach((order) => {
      if (!order.lat || !order.lng) return;
      const assignment = orderAssignmentMap[order.order_id];
      const alert = alertMap[order.order_id];
      const isOverridden = overriddenOrderIds.includes(order.order_id);
      const isHighAlert = alert?.severity === "high";

      const color = isOverridden
        ? "#a78bfa"
        : isHighAlert
        ? "#ff4d6d"
        : VEHICLE_COLORS[assignment?.vehicle_type || "diesel"] || "#ffd166";

      const icon = L.divIcon({
        html: `<div style="
          width:34px;height:34px;border-radius:50%;
          background:${color}20;border:2.5px solid ${color};
          display:flex;align-items:center;justify-content:center;
          font-size:14px;cursor:pointer;
          box-shadow:0 0 12px ${color}88,0 0 24px ${color}44;">
          ${isHighAlert ? "⚠" : order.area_type === "urban" ? "🏙" : order.area_type === "rural" ? "🌾" : "🏘"}
        </div>`,
        className: "",
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([order.lat, order.lng], { icon })
        .bindTooltip(`${order.order_id} · ${order.location_name}`, { className: "map-tt" });

      marker.on("click", () => {
        setSelectedOrder({ order, assignment: assignment || null, alert: alert || null });
      });

      markersLayerRef.current.addLayer(marker);
    });
  }

  // ── Alerts tab: only flagged orders, big warning icons ─────────────────────
  function drawAlertMarkers(L: any, map: any) {
    const severityColor: Record<string, string> = {
      high: "#ff4d6d",
      medium: "#ffd166",
      low: "#06d6a0",
    };

    const alertedOrderIds = new Set((alerts || []).map((a) => a.order_id));

    // Dim non-alerted orders
    orders.forEach((order) => {
      if (!order.lat || !order.lng) return;
      const alert = alertMap[order.order_id];
      const hasAlert = alertedOrderIds.has(order.order_id);
      const color = hasAlert ? severityColor[alert?.severity] || "#ff4d6d" : "#1e3a5a";
      const size = hasAlert ? 40 : 22;
      const emoji = hasAlert
        ? alert.severity === "high" ? "🚨" : alert.severity === "medium" ? "⚠️" : "ℹ️"
        : order.area_type === "urban" ? "🏙" : order.area_type === "rural" ? "🌾" : "🏘";

      const icon = L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          background:${color}20;border:2.5px solid ${color};
          display:flex;align-items:center;justify-content:center;
          font-size:${hasAlert ? 18 : 11}px;cursor:pointer;
          box-shadow:${hasAlert ? `0 0 16px ${color}aa,0 0 32px ${color}55` : "none"};
          opacity:${hasAlert ? 1 : 0.3};">
          ${emoji}
        </div>`,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker([order.lat, order.lng], { icon })
        .bindTooltip(
          hasAlert
            ? `${order.order_id} · ${alert.severity?.toUpperCase()} ALERT`
            : order.order_id,
          { className: "map-tt" }
        );

      if (hasAlert) {
        marker.on("click", () => {
          setSelectedOrder({
            order,
            assignment: orderAssignmentMap[order.order_id] || null,
            alert: alert || null,
          });
        });
      }

      markersLayerRef.current.addLayer(marker);
    });

    // Draw lines from warehouse to high-alert orders
    (alerts || [])
      .filter((a) => a.severity === "high")
      .forEach((a) => {
        const order = orders.find((o) => o.order_id === a.order_id);
        if (!order) return;
        routesLayerRef.current.addLayer(
          L.polyline([[warehouse.lat, warehouse.lng], [order.lat, order.lng]], {
            color: "#ff4d6d",
            weight: 2,
            opacity: 0.6,
            dashArray: "5 5",
          })
        );
      });
  }

  // ── Forecast tab: bubble size = forecasted demand ──────────────────────────
  function drawForecastMarkers(L: any, map: any) {
    orders.forEach((order, idx) => {
      if (!order.lat || !order.lng) return;
      const history = (order as any).order_history_7d || [5, 5, 5, 5, 5, 5, 5];
      const avg = history.reduce((s: number, v: number) => s + v, 0) / history.length;
      const trend = history[history.length - 1] > history[0] ? "↑" : "↓";
      const trendColor = trend === "↑" ? "#06d6a0" : "#ff4d6d";
      const size = Math.max(28, Math.min(56, avg * 6));

      const icon = L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          background:${trendColor}18;
          border:2px solid ${trendColor}88;
          display:flex;align-items:center;justify-content:center;
          font-size:${size > 40 ? 13 : 10}px;font-weight:700;
          color:${trendColor};font-family:monospace;
          box-shadow:0 0 10px ${trendColor}44;cursor:pointer;">
          ${Math.round(avg)}${trend}
        </div>`,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker([order.lat, order.lng], { icon })
        .bindTooltip(
          `${order.location_name} · Avg demand: ${avg.toFixed(1)}/day · Trend: ${trend === "↑" ? "Rising" : "Falling"}`,
          { className: "map-tt" }
        );

      markersLayerRef.current.addLayer(marker);
    });
  }

  // ── Analytics tab: Hurst risk heatmap ─────────────────────────────────────
  function drawAnalyticsMarkers(L: any, map: any) {
    const riskColor: Record<string, string> = {
      high: "#ff4d6d",
      medium: "#ffd166",
      low: "#06d6a0",
      unknown: "#8ab0d0",
    };

    orders.forEach((order) => {
      if (!order.lat || !order.lng) return;
      const history = (order as any).order_history_7d || [5, 5, 5, 5, 5, 5, 5];

      // Simple Hurst-like variance proxy for frontend display
      const mean = history.reduce((s: number, v: number) => s + v, 0) / history.length;
      const variance = history.reduce((s: number, v: number) => s + Math.pow(v - mean, 2), 0) / history.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      const risk = cv > 0.3 ? "high" : cv > 0.15 ? "medium" : "low";
      const color = riskColor[risk];

      const icon = L.divIcon({
        html: `<div style="
          width:38px;height:38px;border-radius:8px;
          background:${color}20;border:2px solid ${color};
          display:flex;align-items:center;justify-content:center;
          font-size:10px;font-weight:800;color:${color};
          font-family:monospace;cursor:pointer;
          box-shadow:0 0 12px ${color}55;">
          ${risk === "high" ? "⚡" : risk === "medium" ? "〜" : "✓"}
        </div>`,
        className: "",
        iconSize: [38, 38],
        iconAnchor: [19, 19],
      });

      const marker = L.marker([order.lat, order.lng], { icon })
        .bindTooltip(
          `${order.location_name} · Risk: ${risk.toUpperCase()} · CV: ${(cv * 100).toFixed(0)}%`,
          { className: "map-tt" }
        );

      markersLayerRef.current.addLayer(marker);
    });
  }

  // ── Arbitration tab: highlight overridden orders ───────────────────────────
  function drawArbitrationMarkers(L: any, map: any) {
    orders.forEach((order) => {
      if (!order.lat || !order.lng) return;
      const isOverridden = overriddenOrderIds.includes(order.order_id);
      const color = isOverridden ? "#a78bfa" : "#1e3a5a";
      const size = isOverridden ? 42 : 24;

      const icon = L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          background:${color}20;border:2.5px solid ${color};
          display:flex;align-items:center;justify-content:center;
          font-size:${isOverridden ? 18 : 11}px;cursor:pointer;
          opacity:${isOverridden ? 1 : 0.25};
          box-shadow:${isOverridden ? `0 0 16px ${color}88` : "none"};">
          ${isOverridden ? "⚖️" : "·"}
        </div>`,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker([order.lat, order.lng], { icon })
        .bindTooltip(
          isOverridden
            ? `${order.order_id} · ARBITRATOR OVERRIDE`
            : order.order_id,
          { className: "map-tt" }
        );

      markersLayerRef.current.addLayer(marker);
    });

    // Lines for overridden orders
    overriddenOrderIds.forEach((oid) => {
      const order = orders.find((o) => o.order_id === oid);
      if (!order) return;
      routesLayerRef.current.addLayer(
        L.polyline([[warehouse.lat, warehouse.lng], [order.lat, order.lng]], {
          color: "#a78bfa",
          weight: 2.5,
          opacity: 0.7,
          dashArray: "4 4",
        })
      );
    });
  }

// ── Vehicle animation (routes tab only) ────────────────────────────────────
  function startVehicleAnimation(L: any, map: any) {
    animRefs.current.forEach((id) => { cancelAnimationFrame(id); clearTimeout(id); });
    animRefs.current = [];

    assignments.forEach((a, idx) => {
      const color = VEHICLE_COLORS[a.vehicle_type] || "#ffd166";
      const label = VEHICLE_LABELS[a.vehicle_type] || "VEH";

      const waypoints: [number, number][] = [[warehouse.lat, warehouse.lng]];
      (a.assigned_order_ids || []).forEach((oid) => {
        const o = orderMap[oid];
        if (o) waypoints.push([o.lat, o.lng]);
      });
      waypoints.push([warehouse.lat, warehouse.lng]);
      if (waypoints.length < 2) return;

      const vehicleIcon = L.divIcon({
        html: `<div style="
          width:44px;height:44px;border-radius:50%;
          background:${color};
          display:flex;align-items:center;justify-content:center;
          font-size:11px;font-weight:800;color:#030b18;
          font-family:monospace;
          border:3px solid rgba(255,255,255,0.7);
          box-shadow:0 0 20px ${color},0 0 40px ${color}88;
          z-index:2000;">${label}</div>`,
        className: "",
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });

      const vehicleMarker = L.marker(waypoints[0], {
        icon: vehicleIcon,
        zIndexOffset: 2000,
      })
        .addTo(vehicleLayerRef.current)
        .bindTooltip(`${a.vehicle_id} · ${a.driver || ""}`, { className: "map-tt" });

      const trailIcon = L.divIcon({
        html: `<div style="width:14px;height:14px;border-radius:50%;background:${color}44;border:1px solid ${color}88;"></div>`,
        className: "",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });

      const trailMarker = L.marker(waypoints[0], { icon: trailIcon, zIndexOffset: 1500 })
        .addTo(vehicleLayerRef.current);

      // Stagger start so vehicles don't all move at once
      const tid = setTimeout(() => {
        animateVehicle(vehicleMarker, trailMarker, waypoints, 0, 0);
      }, idx * 800) as unknown as number;
      animRefs.current.push(tid);
    });
  }

  function animateVehicle(
    marker: any,
    trailMarker: any,
    waypoints: [number, number][],
    seg: number,
    t: number
  ) {
    // Loop back to start when route complete
    if (seg >= waypoints.length - 1) {
      const tid = setTimeout(
        () => animateVehicle(marker, trailMarker, waypoints, 0, 0),
        2000
      ) as unknown as number;
      animRefs.current.push(tid);
      return;
    }

    const from = waypoints[seg];
    const to = waypoints[seg + 1];

    // FIXED: step is a fraction of total journey per frame
    // degDist in Bengaluru is typically 0.01 to 0.15 degrees
    // We want to cross each segment in ~120 frames (2 seconds at 60fps)
    const FRAMES_PER_SEGMENT = 120;
    const step = 1 / FRAMES_PER_SEGMENT;

    const newT = t + step;

    if (newT >= 1) {
      marker.setLatLng(to);
      trailMarker.setLatLng(lerp(from, to, Math.max(0, 1 - step)));
      const id = requestAnimationFrame(() =>
        animateVehicle(marker, trailMarker, waypoints, seg + 1, 0)
      );
      animRefs.current.push(id);
    } else {
      marker.setLatLng(lerp(from, to, newT));
      trailMarker.setLatLng(lerp(from, to, Math.max(0, newT - step)));
      const id = requestAnimationFrame(() =>
        animateVehicle(marker, trailMarker, waypoints, seg, newT)
      );
      animRefs.current.push(id);
    }
  }


  // ── Injected order effect ───────────────────────────────────────────────────
  useEffect(() => {
    if (!injectedOrderId || !mapInstanceRef.current || !leafletRef.current) return;
    const L = leafletRef.current;
    const map = mapInstanceRef.current;

    if (injectedLayerRef.current) {
      try { injectedLayerRef.current.remove(); } catch (_) {}
    }

    const injLat = 12.9756, injLng = 77.6099;

    const injIcon = L.divIcon({
      html: `<div style="
        width:42px;height:42px;border-radius:50%;
        background:#ff4d6d22;border:3px solid #ff4d6d;
        display:flex;align-items:center;justify-content:center;
        font-size:18px;
        box-shadow:0 0 20px #ff4d6d,0 0 40px #ff4d6d44;">⚡</div>`,
      className: "",
      iconSize: [42, 42],
      iconAnchor: [21, 21],
    });

    const injMarker = L.marker([injLat, injLng], { icon: injIcon })
      .addTo(map)
      .bindTooltip(`${injectedOrderId} · MG Road · URGENT`, { className: "map-tt", permanent: true });

    const injLine = L.polyline([[warehouse.lat, warehouse.lng], [injLat, injLng]], {
      color: "#ff4d6d", weight: 2.5, opacity: 0.9, dashArray: "5 5",
    }).addTo(map);

    injectedLayerRef.current = L.layerGroup([injMarker, injLine]);
    map.panTo([injLat, injLng], { animate: true, duration: 0.8 });
  }, [injectedOrderId]);

  const areaColor = (t: string) =>
    t === "urban" ? "#00e5ff" : t === "rural" ? "#ffd166" : "#ff6b9d";

  // Tab label for the map header
  const tabLabels: Record<string, string> = {
    routes: "🚗 LIVE FLEET ROUTES",
    forecast: "📈 DEMAND FORECAST HEATMAP",
    alerts: "🚨 ALERT ZONES",
    analytics: "📊 RISK ANALYTICS",
    arbitration: "⚖️ ARBITRATION OVERRIDES",
  };

  return (
    <>
      <style>{`
        .map-tt {
          background: #0a1628 !important;
          border: 1px solid #1e3a5a !important;
          color: #8ab0d0 !important;
          font-family: monospace !important;
          font-size: 11px !important;
          border-radius: 5px !important;
          box-shadow: none !important;
          padding: 4px 8px !important;
        }
        .map-tt::before { display: none !important; }
        @keyframes whpulse {
          0%,100% { box-shadow: 0 0 20px rgba(0,229,255,0.8), 0 0 40px rgba(0,229,255,0.4); }
          50% { box-shadow: 0 0 30px rgba(0,229,255,1), 0 0 60px rgba(0,229,255,0.6); }
        }
      `}</style>

      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />

      <div style={{ position: "relative", width: "100%" }}>
        {/* Map header showing active tab context */}
        <div style={{
          fontFamily: "monospace",
          fontSize: 11,
          color: "#00e5ff",
          letterSpacing: 2,
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ color: "#1e3a5a" }}>⬡</span>
          {tabLabels[activeTab] || "⬡ LIVE DELIVERY MAP"} — BENGALURU
          <span style={{ color: "#1e3a5a" }}>⬡</span>
        </div>

        {/* Map */}
        <div
          ref={mapRef}
          style={{ width: "100%", height: 460, borderRadius: 10, overflow: "hidden", border: "1px solid #1e3a5a" }}
        />

        {/* Vehicle status strip — routes tab only */}
        {activeTab === "routes" && assignments.length > 0 && (
          <div style={{ position: "absolute", top: 42, right: 10, zIndex: 1000, display: "flex", flexDirection: "column", gap: 5 }}>
            {assignments.map((a, i) => {
              const color = VEHICLE_COLORS[a.vehicle_type] || "#ffd166";
              const label = VEHICLE_LABELS[a.vehicle_type] || "VEH";
              return (
                <div key={`strip-${a.vehicle_id}-${i}`} style={{
                  background: "#0a1628dd", backdropFilter: "blur(8px)",
                  border: `1px solid ${color}55`, borderRadius: 7,
                  padding: "6px 12px", fontFamily: "monospace", fontSize: 11,
                  color: "#8ab0d0", display: "flex", alignItems: "center", gap: 8, minWidth: 170,
                }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: "50%", background: color,
                    boxShadow: `0 0 8px ${color}`, flexShrink: 0,
                    animation: "whpulse 1.5s ease-in-out infinite",
                  }} />
                  <span style={{ color, fontWeight: 700 }}>{label}</span>
                  <span>{a.vehicle_id}</span>
                  <span style={{ color: "#3a5070", marginLeft: "auto", fontSize: 10 }}>
                    {a.assigned_order_ids?.length || 0} stops
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Alert summary strip — alerts tab */}
        {activeTab === "alerts" && alerts.length > 0 && (
          <div style={{ position: "absolute", top: 42, right: 10, zIndex: 1000, display: "flex", flexDirection: "column", gap: 5, maxWidth: 200 }}>
            {alerts.slice(0, 5).map((a, i) => {
              const color = a.severity === "high" ? "#ff4d6d" : a.severity === "medium" ? "#ffd166" : "#06d6a0";
              return (
                <div key={`alert-strip-${i}`} style={{
                  background: "#0a1628dd", backdropFilter: "blur(8px)",
                  border: `1px solid ${color}55`, borderRadius: 7,
                  padding: "5px 10px", fontFamily: "monospace", fontSize: 10,
                  color: "#8ab0d0", display: "flex", alignItems: "center", gap: 6,
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ color }}>{a.severity?.toUpperCase()}</span>
                  <span style={{ color: "#5a8ab0", fontSize: 9 }}>{a.order_id}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Order detail panel */}
        {selectedOrder && (
          <div style={{
            position: "absolute", bottom: 10, left: 10, zIndex: 1000,
            width: 290, background: "#0a1628f0", backdropFilter: "blur(14px)",
            border: "1px solid #1e3a5a", borderRadius: 12, padding: "16px 18px",
            fontFamily: "monospace", fontSize: 12,
          }}>
            <button onClick={() => setSelectedOrder(null)} style={{
              position: "absolute", top: 10, right: 12, background: "none",
              border: "none", color: "#3a5070", cursor: "pointer", fontSize: 15,
            }}>✕</button>

            <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1, marginBottom: 4 }}>ORDER DETAILS</div>
            <div style={{ fontSize: 16, color: "#e8f4ff", fontWeight: 700 }}>{selectedOrder.order.order_id}</div>
            <div style={{ color: "#5a8ab0", marginTop: 3, fontSize: 12, marginBottom: 10 }}>
              📍 {selectedOrder.order.location_name}
            </div>

            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 20, border: `1px solid ${areaColor(selectedOrder.order.area_type)}44`, color: areaColor(selectedOrder.order.area_type) }}>
                {selectedOrder.order.area_type?.toUpperCase()}
              </span>
              <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 20, border: `1px solid ${selectedOrder.order.priority === "high" ? "#ff4d6d44" : "#1e3a5a"}`, color: selectedOrder.order.priority === "high" ? "#ff4d6d" : "#5a8ab0" }}>
                {selectedOrder.order.priority?.toUpperCase()} PRIORITY
              </span>
              {(selectedOrder.order.attempt_count || 0) > 0 && (
                <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 20, border: "1px solid #ffd16644", color: "#ffd166" }}>
                  ⚠ {selectedOrder.order.attempt_count} ATTEMPTS
                </span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
              {[
                { l: "WEIGHT", v: `${selectedOrder.order.weight_kg}kg` },
                { l: "DEADLINE", v: `${selectedOrder.order.deadline_hours}h` },
                { l: "CATEGORY", v: selectedOrder.order.item_category || "—" },
                { l: "TYPE", v: selectedOrder.order.area_type === "rural" ? "Batch" : "Express" },
              ].map((s) => (
                <div key={s.l} style={{ background: "#050d1a", borderRadius: 6, padding: "6px 8px" }}>
                  <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1, marginBottom: 2 }}>{s.l}</div>
                  <div style={{ color: "#8ab0d0" }}>{s.v}</div>
                </div>
              ))}
            </div>

            {selectedOrder.assignment && (
              <div style={{ borderTop: "1px solid #0e2040", paddingTop: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#2a4060", letterSpacing: 1, marginBottom: 7 }}>ASSIGNED TO</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                    background: VEHICLE_COLORS[selectedOrder.assignment.vehicle_type] || "#ffd166",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 800, color: "#030b18", fontFamily: "monospace",
                  }}>
                    {VEHICLE_LABELS[selectedOrder.assignment.vehicle_type] || "VEH"}
                  </div>
                  <div>
                    <div style={{ color: VEHICLE_COLORS[selectedOrder.assignment.vehicle_type] || "#ffd166", fontWeight: 700, fontSize: 13 }}>
                      {selectedOrder.assignment.vehicle_id}
                    </div>
                    <div style={{ color: "#3a5070", fontSize: 10 }}>{selectedOrder.assignment.driver}</div>
                  </div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "#3a5070" }}>{selectedOrder.assignment.total_weight_kg}kg</div>
                    <div style={{ fontSize: 9, color: "#1e3050" }}>/ {selectedOrder.assignment.capacity_kg}kg</div>
                  </div>
                </div>
              </div>
            )}

            {selectedOrder.alert ? (
              <div style={{ background: "#ff4d6d0d", border: "1px solid #ff4d6d33", borderRadius: 7, padding: "9px 11px" }}>
                <div style={{ fontSize: 9, color: "#ff4d6d", letterSpacing: 1, marginBottom: 5 }}>⚠ ALERT · {selectedOrder.alert.severity?.toUpperCase()}</div>
                <div style={{ color: "#ff8099", fontSize: 11, fontFamily: "sans-serif", lineHeight: 1.55, marginBottom: 5 }}>{selectedOrder.alert.message}</div>
                <div style={{ color: "#06d6a0", fontSize: 10, fontFamily: "sans-serif" }}>✓ {selectedOrder.alert.corrective_action}</div>
              </div>
            ) : (
              <div style={{ background: "#06d6a00d", border: "1px solid #06d6a033", borderRadius: 7, padding: "7px 11px", fontSize: 10, color: "#06d6a0", fontFamily: "sans-serif" }}>
                ✓ No alerts for this order
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}