import { useEffect } from "react";
import { APP_EVENTS } from "../app/appEvents";
import {
  emitApiFetchEvents,
  isApiFetch,
  rewriteDevApiRequest,
} from "../lib/apiClient";

export function useBackendAvailability(onBackendUnavailable: () => void) {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init) => {
      const rewrittenInput = rewriteDevApiRequest(input);
      const apiRequest = isApiFetch(rewrittenInput);

      try {
        const response = await originalFetch(rewrittenInput, init);
        if (apiRequest) emitApiFetchEvents(response);
        return response;
      } catch (err) {
        if (apiRequest) {
          window.dispatchEvent(new CustomEvent(APP_EVENTS.backendUnavailable));
        }

        throw err;
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    window.addEventListener(APP_EVENTS.backendUnavailable, onBackendUnavailable);

    return () => {
      window.removeEventListener(
        APP_EVENTS.backendUnavailable,
        onBackendUnavailable
      );
    };
  }, [onBackendUnavailable]);
}
