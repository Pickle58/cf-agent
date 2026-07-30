import "./styles.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useAgent } from "agents/react";
import type { CounterAgent, CounterState } from "./server";

export default function App() {
  const [count, setCount] = useState(0);

  // Connect to the Counter agent
  const agent = useAgent<CounterAgent, CounterState>({
    agent: "CounterAgent",
    onStateUpdate: (state) => setCount(state.count)
  });

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Counter Agent</h1>
      <p style={{ fontSize: "3rem" }}>{count}</p>
      <div style={{ display: "flex", gap: "1rem" }}>
        <button onClick={() => agent.stub.decrement()}>-</button>
        <button onClick={() => agent.stub.reset()}>Reset</button>
        <button onClick={() => agent.stub.increment()}>+</button>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
