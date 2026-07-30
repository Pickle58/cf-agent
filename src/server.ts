import { Agent, routeAgentRequest, callable } from "agents";

// Define the state shape
export type CounterState = {
  count: number;
};

// Create the agent
export class CounterAgent extends Agent<Env, CounterState> {
  // Initial state for new instances
  initialState: CounterState = { count: 0 };

  // Methods marked with @callable can be called from the client
  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  decrement() {
    this.setState({ count: this.state.count - 1 });
    return this.state.count;
  }

  @callable()
  reset() {
    this.setState({ count: 0 });
  }
}

// Route requests to agents
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
