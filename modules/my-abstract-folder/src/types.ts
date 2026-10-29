import { TFile } from "obsidian";
import { ExternalFileEntry } from "./utils/externalIndex";

// Extend the App interface to include the 'commands' property,
// which is available in Obsidian's internal API but might not be in default types.
declare module "obsidian" {
  interface App {
    commands: {
      executeCommandById(commandId: string): void;
    };
  }
}

export const HIDDEN_FOLDER_ID = "abstract-hidden-root"; // Unique ID for the special "Hidden" folder

export interface AbstractFolderFrontmatter {
  children?: string[];
  icon?: string;
  [key: string]: unknown; // Allow other properties
}

export interface ParentChildMap {
  [parentPath: string]: Set<string>; // Parent path -> Set of child paths
}

export interface FileGraph {
  parentToChildren: ParentChildMap;
  childToParents: Map<string, Set<string>>; // Child path -> Set of parent paths (for easier updates)
  allFiles: Set<string>; // All files encountered (parents or children)
  roots: Set<string>; // Root files (those without parents in the graph)
  // 库外文件（vault 外的 md，键 = 磁盘绝对路径）。渲染层用它把 abs 路径
  // 解析成可点击节点；vault 侧逻辑一律不读这个字段。
  externalFiles: Map<string, ExternalFileEntry>;
}

export interface FolderNode {
  file: TFile | null; // The file itself, null for root "folder" nodes that don't correspond to a file
  path: string; // The path of the file or logical folder
  children: FolderNode[];
  isFolder: boolean;
  icon?: string; // Optional icon or emoji from frontmatter
  isHidden?: boolean; // Whether this node should be considered "hidden" from the main tree
  isExternal?: boolean; // 库外文件（path = 磁盘绝对路径，file 恒为 null）
  externalMtime?: number; // 库外文件的修改时间（排序/metrics 用，vault 文件不走这里）
}

export interface Group {
  id: string;
  name: string;
  parentFolders: string[]; // Paths of parent folders to display
  sort?: SortConfig;
  filter?: FilterConfig;
}

export interface NodeMetrics {
  thermal: number;
  lastInteraction: number; // Timestamp
  gravity: number; // Recursive descendant count (Payload)
  rot: number; // Inactivity * Complexity
  complexity: number; // Direct or recursive child count used for rot
}

export type SortBy = 'name' | 'mtime' | 'ctime' | 'thermal' | 'rot' | 'gravity';

export interface SortConfig {
  sortBy: SortBy;
  sortOrder: 'asc' | 'desc';
}

export interface FilterConfig {
  excludeExtensions: string[];
}

export type Cycle = string[]; // Represents a cycle as an array of file paths