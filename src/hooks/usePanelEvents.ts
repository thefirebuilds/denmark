import { useEffect } from "react";
import {
  APP_EVENTS,
  EXPENSE_LEDGER_FOCUS_STORAGE_KEY,
  TRIP_LEDGER_FOCUS_STORAGE_KEY,
} from "../app/appEvents";

type UsePanelEventsOptions = {
  setActiveView: (view: string) => void;
  setSelectedExpenseVehicleId: (vehicleId: number | null) => void;
};

export function usePanelEvents({
  setActiveView,
  setSelectedExpenseVehicleId,
}: UsePanelEventsOptions) {
  useEffect(() => {
    function handleOpenExpenseLedger(event: Event) {
      const customEvent = event as CustomEvent;
      const detail = customEvent?.detail || null;
      if (detail && typeof window !== "undefined") {
        window.sessionStorage.setItem(
          EXPENSE_LEDGER_FOCUS_STORAGE_KEY,
          JSON.stringify(detail)
        );
      }

      if (detail?.vehicleId != null) {
        setSelectedExpenseVehicleId(Number(detail.vehicleId));
      } else {
        setSelectedExpenseVehicleId(null);
      }

      setActiveView("expenses");
    }

    window.addEventListener(
      APP_EVENTS.openExpenseLedger,
      handleOpenExpenseLedger as EventListener
    );

    return () => {
      window.removeEventListener(
        APP_EVENTS.openExpenseLedger,
        handleOpenExpenseLedger as EventListener
      );
    };
  }, [setActiveView, setSelectedExpenseVehicleId]);

  useEffect(() => {
    function handleOpenTripLedger(event: Event) {
      const customEvent = event as CustomEvent;
      const detail = customEvent?.detail || null;
      if (detail && typeof window !== "undefined") {
        window.sessionStorage.setItem(
          TRIP_LEDGER_FOCUS_STORAGE_KEY,
          JSON.stringify(detail)
        );
      }
      setActiveView("ledger");
    }

    window.addEventListener(
      APP_EVENTS.openTripLedger,
      handleOpenTripLedger as EventListener
    );

    return () => {
      window.removeEventListener(
        APP_EVENTS.openTripLedger,
        handleOpenTripLedger as EventListener
      );
    };
  }, [setActiveView]);
}
