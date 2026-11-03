export const GET_PORT_TIMEOUT = 5e3;

export const PORT_READY_EVENT = "mx-port-ready";
export const PORT_MESSAGE_ID_PLACEHOLDER = "__MX_PORT_MESSAGE__";

declare module "obsidian" {
  interface App {
    appId: string;
  }
}

export const getPartition = (id: string) => `persist:mx-player-${id}`;
