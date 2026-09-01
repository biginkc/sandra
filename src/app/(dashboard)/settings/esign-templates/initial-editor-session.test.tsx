import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  InitialEditorSessionProvider,
  useInitialEditorSessionStore,
} from "./initial-editor-session";

const session = {
  providerTemplateId: "provider-1",
  editUrl: "https://app.hellosign.com/editor/initial",
  expiresAt: 123,
  clientId: "client-1",
};

describe("InitialEditorSessionProvider", () => {
  it("keeps an initial session in memory and consumes it exactly once for its template", () => {
    render(
      <InitialEditorSessionProvider>
        <Probe />
      </InitialEditorSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Put" }));
    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    expect(screen.getByTestId("result")).toHaveTextContent(session.editUrl);

    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    expect(screen.getByTestId("result")).toHaveTextContent("absent");
  });

  it("does not give the session to a different template", () => {
    render(
      <InitialEditorSessionProvider>
        <Probe />
      </InitialEditorSessionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Put" }));
    fireEvent.click(screen.getByRole("button", { name: "Take other" }));
    expect(screen.getByTestId("result")).toHaveTextContent("absent");
    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    expect(screen.getByTestId("result")).toHaveTextContent(session.editUrl);
  });
});

function Probe() {
  const store = useInitialEditorSessionStore();
  const [result, setResult] = useState("unset");
  return (
    <>
      <button onClick={() => store.put("template-1", session)}>Put</button>
      <button
        onClick={() => setResult(store.take("template-1")?.editUrl ?? "absent")}
      >
        Take
      </button>
      <button
        onClick={() => setResult(store.take("template-2")?.editUrl ?? "absent")}
      >
        Take other
      </button>
      <output data-testid="result">{result}</output>
    </>
  );
}
