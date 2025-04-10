#!/usr/bin/env node

import { keccak256, toHex, createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import {
  HypersyncClient,
  LogField,
  JoinMode,
  TransactionField,
  Decoder,
} from "@envio-dev/hypersync-client";
import chalk from "chalk";
import figlet from "figlet";
import { Command } from "commander";
import ora from "ora";
import readline from "readline";
import boxen from "boxen";
import fs from "fs";
import path from "path";
import Table from "cli-table3";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Get directory of current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import extraRpcs dynamically
let extraRpcs = {};
try {
  const extraRpcsPath = path.resolve(__dirname, "./extraRpcs.js");
  if (fs.existsSync(extraRpcsPath)) {
    const module = await import(extraRpcsPath);
    extraRpcs = module.default || {};
  }
} catch (error) {
  console.warn(
    chalk.yellow(`Warning: Could not load extraRpcs.js: ${error.message}`)
  );
}

// List of safe chalk colors for dynamically assigned chains
const SAFE_COLORS = [
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
];

// Load chain data from networkCache.json or fetch from API
let networkData = [];
try {
  const networkCachePath = path.resolve(__dirname, "./networkCache.json");
  if (fs.existsSync(networkCachePath)) {
    networkData = JSON.parse(fs.readFileSync(networkCachePath, "utf8"));
  } else {
    // In a production app, we'd fetch from API here
    console.warn(chalk.yellow("Warning: Could not find networkCache.json"));
  }
} catch (error) {
  console.warn(
    chalk.yellow(`Warning: Could not load networkCache.json: ${error.message}`)
  );
}

// List of preferred chains to include by default
const PREFERRED_CHAINS = [
  "eth",
  "optimism",
  "arbitrum",
  "gnosis",
  "xdc",
  "unichain",
  "avalanche",
];

// Create a map of name to chain data for quick lookup
const chainNameToData = {};
networkData.forEach((chain) => {
  chainNameToData[chain.name] = chain;
});

// Create dynamic SUPPORTED_CHAINS object with colors
const SUPPORTED_CHAINS = {};

// First, add all chains from networkCache.json
networkData.forEach((chain, index) => {
  if (chain.ecosystem === "evm" && chain.chain_id) {
    // Assign a color from the safe colors array, cycling through them if needed
    const colorIndex = index % SAFE_COLORS.length;
    const color = SAFE_COLORS[colorIndex];

    // Capitalize first letter of chain name
    const displayName =
      chain.name.charAt(0).toUpperCase() + chain.name.slice(1);

    SUPPORTED_CHAINS[chain.chain_id] = {
      name: displayName,
      color: color,
      hypersyncUrl: `http://${chain.chain_id}.hypersync.xyz`,
    };
  }
});

// Apply special color assignments for well-known chains
if (SUPPORTED_CHAINS[1]) SUPPORTED_CHAINS[1].color = "cyan"; // Ethereum
if (SUPPORTED_CHAINS[10]) SUPPORTED_CHAINS[10].color = "redBright"; // Optimism
if (SUPPORTED_CHAINS[137]) SUPPORTED_CHAINS[137].color = "magenta"; // Polygon
if (SUPPORTED_CHAINS[42161]) SUPPORTED_CHAINS[42161].color = "blue"; // Arbitrum
if (SUPPORTED_CHAINS[8453]) SUPPORTED_CHAINS[8453].color = "blue"; // Base
if (SUPPORTED_CHAINS[100]) SUPPORTED_CHAINS[100].color = "green"; // Gnosis
if (SUPPORTED_CHAINS[43114]) SUPPORTED_CHAINS[43114].color = "red"; // Avalanche

// If no chains were loaded, provide fallbacks for core chains
if (Object.keys(SUPPORTED_CHAINS).length === 0) {
  console.warn(chalk.yellow("Warning: Using fallback chain configuration"));
  // Fallback to core chains
  const fallbackChains = {
    1: {
      name: "Ethereum",
      color: "cyan",
      hypersyncUrl: "http://1.hypersync.xyz",
    },
    10: {
      name: "Optimism",
      color: "redBright",
      hypersyncUrl: "http://10.hypersync.xyz",
    },
    137: {
      name: "Polygon",
      color: "magenta",
      hypersyncUrl: "http://137.hypersync.xyz",
    },
    42161: {
      name: "Arbitrum",
      color: "blue",
      hypersyncUrl: "http://42161.hypersync.xyz",
    },
    8453: {
      name: "Base",
      color: "greenBright",
      hypersyncUrl: "http://8453.hypersync.xyz",
    },
    100: {
      name: "Gnosis",
      color: "green",
      hypersyncUrl: "http://100.hypersync.xyz",
    },
    43114: {
      name: "Avalanche",
      color: "red",
      hypersyncUrl: "http://43114.hypersync.xyz",
    },
  };

  Object.assign(SUPPORTED_CHAINS, fallbackChains);
}

// Get default chain IDs string
const DEFAULT_CHAIN_IDS = Object.keys(SUPPORTED_CHAINS).join(",");

// Cache for token metadata
const tokenMetadataCache = new Map();

// ERC20 ABI for token metadata
const ERC20_ABI = [
  {
    constant: true,
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

// Fetch token metadata from a list of RPCs with improved retry logic
async function fetchTokenMetadata(tokenAddress, chainId = 1) {
  // Check cache first
  const cacheKey = `${chainId}:${tokenAddress}`;
  if (tokenMetadataCache.has(cacheKey)) {
    return tokenMetadataCache.get(cacheKey);
  }

  // Get RPC URLs for the chain
  let rpcUrls = [];
  if (extraRpcs[chainId]) {
    extraRpcs[chainId].rpcs.forEach((rpc) => {
      if (typeof rpc === "string") {
        rpcUrls.push(rpc);
      } else if (rpc.url) {
        rpcUrls.push(rpc.url);
      }
    });
  }

  // If no RPCs available, return default values
  if (rpcUrls.length === 0) {
    return {
      success: false,
      name: "Unknown Token",
      symbol: "???",
      decimals: 18,
      formattedName: "Unknown Token (???)",
    };
  }

  // Shuffle RPC URLs to avoid always hitting the same one first
  rpcUrls = shuffleArray([...rpcUrls]);

  let lastError = null;
  let retryCount = 0;

  // Try each RPC until one works, with exponential backoff between retries
  for (const rpcUrl of rpcUrls) {
    try {
      if (rpcUrl.startsWith("wss://")) continue; // Skip WebSocket RPCs for now

      // Add a small delay between retries with exponential backoff
      if (retryCount > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(200 * Math.pow(1.5, retryCount), 2000))
        );
      }
      retryCount++;

      // Create a viem client with timeout
      const client = createPublicClient({
        chain: mainnet, // This is just for typing, we'll override with custom endpoint
        transport: http(rpcUrl, {
          timeout: 3000, // 3 second timeout for RPC calls
          fetchOptions: {
            headers: {
              "Content-Type": "application/json",
            },
          },
        }),
      });

      // Fetch token metadata (name, symbol, decimals) in parallel
      const [name, symbol, decimals] = await Promise.all([
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "name",
          })
          .catch((e) => null),
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "symbol",
          })
          .catch((e) => null),
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "decimals",
          })
          .catch((e) => 18),
      ]);

      // If we got at least one piece of metadata
      if (name !== null || symbol !== null) {
        const finalName = name || "Unknown Token";
        const finalSymbol = symbol || "???";

        const metadata = {
          success: true,
          name: finalName,
          symbol: finalSymbol,
          decimals,
          formattedName: `${finalName} (${finalSymbol})`,
        };

        // Cache the result
        tokenMetadataCache.set(cacheKey, metadata);
        return metadata;
      }

      // If both name and symbol are null, consider this attempt failed
      lastError = new Error("Token metadata not available");
    } catch (error) {
      lastError = error;
      // Continue to the next RPC if this one fails
    }
  }

  // If we have a default (placeholder) metadata in cache from a previous failed attempt,
  // use that instead of creating a new default object every time
  const defaultMetadata = {
    success: false,
    name: "Unknown Token",
    symbol: "???",
    decimals: 18,
    formattedName: "Unknown Token (???)",
  };

  // Cache the default result to avoid repeated failed requests
  tokenMetadataCache.set(cacheKey, defaultMetadata);
  return defaultMetadata;
}

// Utility to shuffle array (for randomizing RPC order)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Format token amounts with proper decimals
function formatTokenAmount(amount, decimals) {
  if (!amount) return "0";

  try {
    return formatUnits(amount, decimals);
  } catch (error) {
    return amount.toString();
  }
}

// Global variables for interactive mode
let approvalsList = [];
let selectedApprovalIndex = 0;
let currentPage = 0;
const PAGE_SIZE = 8; // Number of approvals to show per page

// Group approvals by token for better display
let groupedApprovals = {};

// Scanning stats to preserve after completion
let chainStats = {};

// Create global readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

// CLI setup - note the change to use DEFAULT_CHAIN_IDS
const program = new Command();
program
  .name("snubb")
  .description("Terminal UI for finding and revoking Ethereum token approvals")
  .version("1.0.0")
  .option("-a, --address <address>", "Ethereum address to check approvals for")
  .option(
    "-c, --chains <chainIds>",
    "Comma-separated chain IDs or 'many-networks' to scan multiple networks (default: 1 - Ethereum only)",
    "1"
  )
  .option(
    "--list-chains",
    "Display a list of all supported chains from networkCache.json"
  )
  .parse(process.argv);

const options = program.opts();

// Check if user wants to list all supported chains
if (options.listChains) {
  console.log(
    chalk.bold.cyan(figlet.textSync("Supported Chains", { font: "Small" }))
  );
  console.log(
    chalk.bold.cyan("List of all supported chains from networkCache.json\n")
  );

  // Create a table for better display
  const chainsTable = new Table({
    head: [
      chalk.cyan.bold("CHAIN ID"),
      chalk.cyan.bold("NAME"),
      chalk.cyan.bold("TIER"),
    ],
    colWidths: [12, 25, 12],
    style: {
      head: [], // No additional styling for headers
      border: [], // No additional styling for borders
    },
  });

  // Sort networkData by chain ID for easier reading
  const sortedChains = [...networkData]
    .filter((chain) => chain.ecosystem === "evm") // Only show EVM chains
    .sort((a, b) => a.chain_id - b.chain_id);

  // Add each chain to the table
  sortedChains.forEach((chain) => {
    chainsTable.push([chain.chain_id.toString(), chain.name, chain.tier]);
  });

  // Display the table
  console.log(chainsTable.toString());
  console.log(
    `\nTo use: ${chalk.green(
      "snubb --address <your-address> --chains <comma-separated-chain-ids>"
    )}`
  );
  process.exit(0);
}

// Check if we have an address
let TARGET_ADDRESS = options.address;
if (!TARGET_ADDRESS) {
  console.log(
    chalk.bold.cyan(
      figlet.textSync("snubb", {
        font: "ANSI Shadow",
        horizontalLayout: "full",
      })
    )
  );
  console.log(
    chalk.bold.cyan("multichain token approval scanner") +
      " - " +
      chalk.cyan("powered by ") +
      chalk.cyan.underline("envio.dev") +
      "\n"
  );

  console.log(chalk.yellow("Usage:"));
  console.log(
    chalk.green(
      "  snubb --address 0x7C25a8C86A04f40F2Db0434ab3A24b051FB3cA58\n"
    )
  );
  console.log(chalk.yellow("Options:"));
  console.log(
    chalk.green(
      `  --chains <chainIds>  Comma-separated chain IDs to scan (default: 1 - Ethereum only)\n`
    )
  );
  console.log(
    chalk.green(
      `  --chains many-networks  Scan multiple supported networks (${PREFERRED_CHAINS.join(
        ", "
      )})\n`
    )
  );
  console.log(
    chalk.green(`  --list-chains  Display a list of all supported chains\n`)
  );

  process.exit(0);
}

// Get chain IDs from options
let CHAIN_IDS = [];

// Check if 'many-networks' keyword is used
if (options.chains.toLowerCase() === "many-networks") {
  // Use all preferred networks
  for (const chainName of PREFERRED_CHAINS) {
    const chain = chainNameToData[chainName];
    if (chain) {
      CHAIN_IDS.push(chain.chain_id);
    }
  }
} else {
  // Otherwise use the specified chains
  const requestedChainIds = options.chains
    .split(",")
    .map((id) => parseInt(id.trim()));

  for (const chainId of requestedChainIds) {
    // Check if this chain ID exists in networkData (networkCache.json)
    const chainData = networkData.find(
      (chain) => chain.chain_id === chainId && chain.ecosystem === "evm"
    );

    if (chainData) {
      // If in networkData, check if already added to SUPPORTED_CHAINS
      if (!SUPPORTED_CHAINS[chainId]) {
        // Get a color from SAFE_COLORS
        const colorIndex = Math.floor(Math.random() * SAFE_COLORS.length);
        const color = SAFE_COLORS[colorIndex];

        // Add to SUPPORTED_CHAINS
        SUPPORTED_CHAINS[chainId] = {
          name:
            chainData.name.charAt(0).toUpperCase() + chainData.name.slice(1),
          color: color,
          hypersyncUrl: `http://${chainId}.hypersync.xyz`,
        };
      }

      // Now add to CHAIN_IDS
      CHAIN_IDS.push(chainId);
    } else {
      // Chain not in networkCache.json - this is an error
      console.error(chalk.red(`Error: Chain ID ${chainId} is not supported.`));
      console.error(
        chalk.yellow(
          `Run '${chalk.green(
            "snubb --list-chains"
          )}' to see all supported chains.`
        )
      );
      process.exit(1);
    }
  }
}

// If no valid chains, use Ethereum mainnet
if (CHAIN_IDS.length === 0) {
  CHAIN_IDS.push(1); // Fallback to Ethereum mainnet
}

// Normalize address
TARGET_ADDRESS = TARGET_ADDRESS.toLowerCase();
if (!TARGET_ADDRESS.startsWith("0x")) {
  TARGET_ADDRESS = "0x" + TARGET_ADDRESS;
}

// Address formatting for topic filtering
const TARGET_ADDRESS_NO_PREFIX = TARGET_ADDRESS.substring(2).toLowerCase();
const TARGET_ADDRESS_PADDED =
  "0x000000000000000000000000" + TARGET_ADDRESS_NO_PREFIX;

// Define ERC20 event signatures
const event_signatures = [
  "Transfer(address,address,uint256)",
  "Approval(address,address,uint256)",
];

// Create topic0 hashes from event signatures
const topic0_list = event_signatures.map((sig) => keccak256(toHex(sig)));

// Store individual topic hashes for easier comparison
const TRANSFER_TOPIC = topic0_list[0];
const APPROVAL_TOPIC = topic0_list[1];

// Create mapping from topic0 hash to event name
const topic0ToName = {};
topic0ToName[TRANSFER_TOPIC] = "Transfer";
topic0ToName[APPROVAL_TOPIC] = "Approval";

// Helper functions for UI
const formatNumber = (num) => {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const formatToken = (tokenAddress, tokenMetadata) => {
  if (tokenMetadata && tokenMetadata.success) {
    return tokenMetadata.formattedName;
  }

  if (tokenAddress.length <= 12) return tokenAddress;
  return `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-6)}`;
};

// Check if an amount is effectively unlimited (close to 2^256-1)
const isEffectivelyUnlimited = (amount) => {
  // Common unlimited values (2^256-1 and similar large numbers)
  const MAX_UINT256 = BigInt(
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  );
  const LARGE_THRESHOLD = MAX_UINT256 - MAX_UINT256 / BigInt(1000); // Within 0.1% of max

  return amount > LARGE_THRESHOLD;
};

const formatAmount = (amount, tokenMetadata) => {
  if (!amount) return "0";

  // Check for unlimited or very large approval (effectively unlimited)
  if (
    amount === BigInt(2) ** BigInt(256) - BigInt(1) ||
    amount ===
      BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      ) ||
    isEffectivelyUnlimited(amount)
  ) {
    return "∞ (Unlimited)";
  }

  // Format with decimals if available
  if (tokenMetadata && tokenMetadata.success) {
    return formatTokenAmount(amount, tokenMetadata.decimals);
  }

  // Format large numbers with abbr (fallback)
  if (amount > BigInt(1000000000000)) {
    return `${Number(amount / BigInt(1000000000000)).toFixed(2)}T`;
  } else if (amount > BigInt(1000000000)) {
    return `${Number(amount / BigInt(1000000000)).toFixed(2)}B`;
  } else if (amount > BigInt(1000000)) {
    return `${Number(amount / BigInt(1000000)).toFixed(2)}M`;
  } else if (amount > BigInt(1000)) {
    return `${Number(amount / BigInt(1000)).toFixed(2)}K`;
  }

  return amount.toString();
};

// Format chain name with color (safely)
const formatChainName = (chainId) => {
  if (!SUPPORTED_CHAINS[chainId]) {
    return chalk.white(`Chain ${chainId}`);
  }

  const chain = SUPPORTED_CHAINS[chainId];
  const colorName = chain.color || "white";

  // Safely apply color
  try {
    if (chalk[colorName]) {
      return chalk[colorName](chain.name);
    } else {
      return chalk.white(chain.name);
    }
  } catch (error) {
    return chalk.white(chain.name);
  }
};

// Draw progress bar with safe color handling
function drawProgressBar(progress, width = 40, colorName = "cyan") {
  const filledWidth = Math.floor(width * progress);
  const emptyWidth = width - filledWidth;

  // Ensure we draw something even at 100%
  const filledChar = "█";
  const emptyChar = "░";
  const filledBar = filledChar.repeat(Math.max(1, filledWidth));
  const emptyBar = emptyChar.repeat(emptyWidth);

  // Safely apply color
  try {
    if (chalk[colorName]) {
      return chalk[colorName](filledBar) + emptyBar;
    } else {
      return chalk.cyan(filledBar) + emptyBar;
    }
  } catch (error) {
    return chalk.cyan(filledBar) + emptyBar;
  }
}

// Create a query for ERC20 events related to our target address
const createQuery = (fromBlock) => ({
  fromBlock,
  logs: [
    // Filter for Approval events where target address is the owner (topic1)
    {
      topics: [[APPROVAL_TOPIC], [TARGET_ADDRESS_PADDED], []],
    },
    // Filter for Transfer events where target address is from (topic1)
    {
      topics: [[TRANSFER_TOPIC], [TARGET_ADDRESS_PADDED], []],
    },
    // Also get Transfer events where target address is to (topic2)
    {
      topics: [[TRANSFER_TOPIC], [], [TARGET_ADDRESS_PADDED]],
    },
  ],
  // Also filter for transactions involving the target address
  transactions: [
    {
      from: [TARGET_ADDRESS],
    },
    {
      to: [TARGET_ADDRESS],
    },
  ],
  fieldSelection: {
    log: [
      LogField.BlockNumber,
      LogField.LogIndex,
      LogField.TransactionIndex,
      LogField.TransactionHash,
      LogField.Data,
      LogField.Address,
      LogField.Topic0,
      LogField.Topic1,
      LogField.Topic2,
      LogField.Topic3,
    ],
    transaction: [
      TransactionField.From,
      TransactionField.To,
      TransactionField.Hash,
    ],
  },
  joinMode: JoinMode.JoinTransactions,
});

// Add a new state variable near the other global variables
let detailsExpanded = false;

// Function to display the approvals list
async function displayApprovalsList() {
  console.clear();

  // Display header with logo and stats
  console.log(chalk.bold.cyan(figlet.textSync("snubb", { font: "Doom" })));
  console.log(
    chalk.bold.cyan("multichain token approval scanner") +
      " - " +
      chalk.cyan("powered by ") +
      chalk.cyan.underline("envio.dev") +
      "\n"
  );

  // Display scan progress and summary separately
  displayScanSummary();

  // Calculate page bounds
  const startIdx = currentPage * PAGE_SIZE;
  const endIdx = Math.min(startIdx + PAGE_SIZE, approvalsList.length);
  const totalPages = Math.ceil(approvalsList.length / PAGE_SIZE);

  // Navigation header with enhanced information
  console.log(
    boxen(
      chalk.bold.cyan(
        `OUTSTANDING APPROVALS (${currentPage + 1}/${totalPages}) - Showing ${
          startIdx + 1
        }-${endIdx} of ${approvalsList.length}`
      ),
      {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderColor: "yellow",
        borderStyle: "round",
      }
    )
  );

  // Create a more structured table for approvals with proper hierarchy
  displayApprovalsTable(startIdx, endIdx);

  // Display details of the selected approval only if expanded
  if (approvalsList.length > 0 && detailsExpanded) {
    const approval = approvalsList[selectedApprovalIndex];

    // Use cached token metadata if available
    const tokenMetadata = tokenMetadataCache.get(
      `${approval.chainId}:${approval.tokenAddress}`
    );

    // Display approval details with available metadata
    displayApprovalDetails(approval, tokenMetadata || { success: false });
  } else if (approvalsList.length > 0) {
    // Show a hint to expand details
    console.log(
      boxen(
        chalk.dim(
          "Press ENTER to view detailed information for the selected approval"
        ),
        {
          padding: { top: 0, bottom: 0, left: 1, right: 1 },
          borderColor: "blue",
          borderStyle: "round",
        }
      )
    );
  }

  // Add revoke.cash link right above navigation commands
  const revokeLink = `https://revoke.cash/address/${TARGET_ADDRESS}`;
  console.log(
    boxen(
      chalk.bold.white(
        `⚠️  REVOKE APPROVALS: ${chalk.bold.cyan.underline(revokeLink)}`
      ),
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        margin: { top: 1, bottom: 0 },
        borderColor: "red",
        borderStyle: "round",
      }
    )
  );

  // Move navigation instructions to the bottom near the input prompt
  console.log(
    "\n" +
      boxen(
        [
          chalk.cyan("Navigation Commands:"),
          `${chalk.yellow("n")} - Next approval    ${chalk.yellow(
            "p"
          )} - Previous approval`,
          `${chalk.yellow(">")} - Next page        ${chalk.yellow(
            "<"
          )} - Previous page`,
          `${chalk.yellow("ENTER")} - Show/hide details`,
          `${chalk.yellow("q")} - Quit             ${chalk.yellow("h")} - Help`,
        ].join("\n"),
        {
          padding: { top: 1, bottom: 1, left: 2, right: 2 },
          margin: { top: 0, bottom: 1 },
          borderColor: "magenta",
          borderStyle: "round",
        }
      )
  );

  // Start fetching metadata in the background
  fetchTokenMetadataInBackground(startIdx, endIdx);
}

// Function to display approvals in a professionally formatted table
function displayApprovalsTable(startIdx, endIdx) {
  // Create a new table for approvals with clean styling
  const approvalsTable = new Table({
    head: [
      chalk.cyan.bold("CHAIN"),
      chalk.cyan.bold("TOKEN"),
      chalk.cyan.bold("SPENDER"),
      chalk.cyan.bold("AMOUNT"),
    ],
    colWidths: [10, 18, 23, 35],
    style: {
      head: [], // No additional styling for headers
      border: [], // No additional styling for borders
      compact: true, // More compact table
    },
    chars: {
      top: "━",
      "top-mid": "┳",
      "top-left": "┏",
      "top-right": "┓",
      bottom: "━",
      "bottom-mid": "┻",
      "bottom-left": "┗",
      "bottom-right": "┛",
      left: "┃",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "┃",
      "right-mid": "",
      middle: "┃",
    },
  });

  // Keep track of current chain to handle grouping
  let currentChainId = null;
  let currentTokenAddress = null;

  // Display the approvals with token metadata when available
  for (let i = startIdx; i < endIdx; i++) {
    const approval = approvalsList[i];
    const isSelected = i === selectedApprovalIndex;

    // Check if this is a new chain
    const isNewChain = currentChainId !== approval.chainId;
    const isNewToken =
      currentTokenAddress !== approval.tokenAddress || isNewChain;

    // Get token metadata
    const tokenMetadata = tokenMetadataCache.get(
      `${approval.chainId}:${approval.tokenAddress}`
    );

    // Format token display based on available metadata
    const tokenDisplay =
      tokenMetadata && tokenMetadata.success
        ? `${chalk.cyan(tokenMetadata.symbol)}`
        : chalk.cyan(approval.tokenAddress.slice(0, 6) + "...");

    // Format spender display with selection indicator and truncation if needed
    const spenderText = formatToken(approval.spender);
    // Truncate long spender addresses to fit column
    const displaySpender =
      spenderText.length > 18
        ? spenderText.slice(0, 8) + "..." + spenderText.slice(-8)
        : spenderText;

    const spenderDisplay = isSelected
      ? chalk.yellow.bold(`→ ${displaySpender}`)
      : chalk.yellow(displaySpender);

    // Update unlimited flag for effectively unlimited values
    const isEffectiveUnlimited = isEffectivelyUnlimited(
      approval.remainingApproval
    );
    const displayAsUnlimited = approval.isUnlimited || isEffectiveUnlimited;

    // Format amount display
    const amountDisplay = displayAsUnlimited
      ? isSelected
        ? chalk.red.bold("⚠️ UNLIMITED")
        : chalk.red.bold("⚠️ ∞")
      : chalk.green(formatAmount(approval.remainingApproval, tokenMetadata));

    // Handle chain grouping - only show chain name for the first entry of the chain
    const chainCell = isNewChain ? formatChainName(approval.chainId) : "";

    // Add row to table
    approvalsTable.push([
      chainCell,
      tokenDisplay,
      spenderDisplay,
      amountDisplay,
    ]);

    // Update tracking variables
    if (isNewChain) {
      currentChainId = approval.chainId;
    }

    if (isNewToken) {
      currentTokenAddress = approval.tokenAddress;
    }
  }

  // Display the table
  console.log(approvalsTable.toString());
}

// Function to display progress bars and summary table sequentially
function displayScanSummary() {
  // Calculate maximum width needed for chain names
  const chainNameWidth =
    Math.max(
      ...CHAIN_IDS.map((id) => formatChainName(id).length),
      10 // Minimum width
    ) + 2; // Add some padding

  // Display progress bars header
  console.log(chalk.bold.yellow("SCAN PROGRESS"));

  // Display progress bars
  for (const chainId of CHAIN_IDS) {
    if (chainStats[chainId]) {
      const stats = chainStats[chainId];
      // Use consistent padding and formatting for all chains
      const chainName = formatChainName(chainId);
      const paddedChainName = chainName.padEnd(chainNameWidth);

      // Create progress bar line with fixed spacing
      console.log(
        `  ${paddedChainName}: [${stats.progressBar}] 100.00% ${chalk.green(
          "✓ Complete"
        )}`
      );
    }
  }

  // Create summary table
  console.log(chalk.bold.yellow("\nSUMMARY"));

  const statsTable = new Table({
    head: [
      chalk.cyan("CHAIN"),
      chalk.cyan("HEIGHT"),
      chalk.cyan("EVENTS"),
      chalk.cyan("TIME"),
      chalk.cyan("APPROVALS"),
    ],
    colWidths: [15, 15, 10, 8, 10],
    style: {
      head: [], // No additional styling for headers
      border: [], // No additional styling for borders
      compact: true, // More compact table with less padding
    },
  });

  // Add rows to the table from chain stats
  let totalApprovals = 0;
  for (const chainId of CHAIN_IDS) {
    if (chainStats[chainId]) {
      const stats = chainStats[chainId];

      // Add a row with colored chain name and right-aligned numeric data
      statsTable.push([
        formatChainName(chainId), // Already has color applied
        formatNumber(stats.height),
        formatNumber(stats.totalEvents),
        `${(stats.endTime / 1000).toFixed(1)}s`,
        stats.approvalsCount.toString(),
      ]);

      totalApprovals += stats.approvalsCount;
    }
  }

  // Add a totals row
  statsTable.push([
    chalk.bold("TOTAL"),
    "",
    "",
    "",
    chalk.bold.white(totalApprovals.toString()),
  ]);

  // Display the table
  console.log(statsTable.toString());
  console.log(""); // Add spacing
}

// Asynchronous function to fetch token metadata in background
async function fetchTokenMetadataInBackground(startIdx, endIdx) {
  // Collection of unique token addresses on the current page
  const tokensToFetch = new Set();

  // Collect all tokens that need metadata
  for (let i = startIdx; i < endIdx; i++) {
    if (i < approvalsList.length) {
      const approval = approvalsList[i];
      const cacheKey = `${approval.chainId}:${approval.tokenAddress}`;

      // Only fetch tokens that aren't already in the cache
      if (!tokenMetadataCache.has(cacheKey)) {
        tokensToFetch.add({
          chainId: approval.chainId,
          tokenAddress: approval.tokenAddress,
        });
      }
    }
  }

  // If no tokens to fetch, we're done
  if (tokensToFetch.size === 0) return;

  // Fetch token metadata in parallel
  const promises = Array.from(tokensToFetch).map(
    async ({ chainId, tokenAddress }) => {
      await fetchTokenMetadata(tokenAddress, chainId);
    }
  );

  // Wait for all fetches to complete then redraw the screen
  await Promise.all(promises);
  displayApprovalsList();
}

// Function to display approval details
function displayApprovalDetails(approval, tokenMetadata) {
  // Get chain info
  const chain = SUPPORTED_CHAINS[approval.chainId] || {
    name: `Chain ${approval.chainId}`,
    color: "white",
  };

  console.log(
    "\n" +
      boxen(chalk.bold.cyan("APPROVAL DETAILS"), {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderColor: "green",
        borderStyle: "round",
      })
  );

  // Update unlimited flag for effectively unlimited values
  const isEffectiveUnlimited = isEffectivelyUnlimited(
    approval.remainingApproval
  );
  const displayAsUnlimited = approval.isUnlimited || isEffectiveUnlimited;

  // Create a more readable single-column display
  const detailsContent = [
    // Chain information
    `${chalk.cyan.bold("Chain:")} ${formatChainName(approval.chainId)}`,
    "",

    // Token information
    tokenMetadata && tokenMetadata.success
      ? `${chalk.cyan.bold("Token:")} ${chalk.green(tokenMetadata.name)} (${
          tokenMetadata.symbol
        })`
      : `${chalk.cyan.bold("Token:")} ${chalk.green(approval.tokenAddress)}`,

    `${chalk.cyan.bold("Token Address:")} ${chalk.green(
      approval.tokenAddress
    )}`,
    "",

    // Spender information
    `${chalk.cyan.bold("Spender Address:")} ${chalk.green(approval.spender)}`,
    "",

    // Approval amounts
    chalk.cyan.bold("Approval Details:"),
    `${chalk.yellow("Approved Amount:")} ${chalk.green(
      displayAsUnlimited
        ? "∞ (Unlimited)"
        : formatAmount(approval.approvedAmount, tokenMetadata)
    )}`,
    `${chalk.yellow("Used Amount:")} ${chalk.green(
      formatAmount(approval.transferredAmount, tokenMetadata)
    )}`,
    `${chalk.yellow("Remaining:")} ${
      displayAsUnlimited
        ? chalk.red.bold("∞ (UNLIMITED)")
        : chalk.green(formatAmount(approval.remainingApproval, tokenMetadata))
    }`,
    "",

    // Transaction information
    chalk.cyan.bold("Transaction Details:"),
    `${chalk.yellow("Block Number:")} ${approval.blockNumber}`,
    `${chalk.yellow("Transaction Hash:")} ${approval.txHash}`,
  ].join("\n");

  // Display the details
  console.log(
    boxen(detailsContent, {
      padding: 1,
      borderColor: "blue",
      borderStyle: "round",
    })
  );

  // Display warning for unlimited approvals
  if (displayAsUnlimited) {
    console.log(
      boxen(
        chalk.bold.white(
          "⚠️  UNLIMITED APPROVAL - This contract has unlimited access to this token in your wallet"
        ),
        { padding: 1, borderColor: "red", borderStyle: "round" }
      )
    );
  }
}

// Help screen to display all commands
function displayHelpScreen() {
  console.clear();

  console.log(chalk.bold.cyan(figlet.textSync("HELP", { font: "Doom" })));
  console.log(
    chalk.bold.cyan("multichain token approval scanner") +
      " - " +
      chalk.cyan("powered by ") +
      chalk.cyan.underline("envio.dev") +
      "\n"
  );
  const helpContent = boxen(
    [
      chalk.bold.yellow("COMMAND REFERENCE"),
      "",
      `${chalk.yellow("n")} - Move to the next approval in the list`,
      `${chalk.yellow("p")} - Move to the previous approval in the list`,
      `${chalk.yellow(">")} - Go to next page of approvals`,
      `${chalk.yellow("<")} - Go to previous page of approvals`,
      `${chalk.yellow("h")} - Show this help screen`,
      `${chalk.yellow("q")} - Quit the application`,
      "",
      chalk.bold.yellow("ABOUT TOKEN APPROVALS"),
      "",
      `${chalk.white(
        "Token approvals give dApps permission to spend your tokens."
      )}`,
      `${chalk.white(
        "Unlimited approvals (∞) are a security risk as they never expire."
      )}`,
      `${chalk.white(
        "Consider revoking unused approvals to improve your wallet security."
      )}`,
      "",
      chalk.bold.yellow("PRESS ANY KEY TO RETURN"),
    ].join("\n"),
    {
      padding: 1,
      borderColor: "cyan",
      borderStyle: "round",
    }
  );

  // Add a separate, more prominent box for the revoke.cash link
  const revokeLink = `https://revoke.cash/address/${TARGET_ADDRESS}`;
  const revokeLinkContent = boxen(
    [
      chalk.bold.yellow("⚠️  HOW TO REVOKE APPROVALS ⚠️"),
      "",
      `${chalk.white("To manage and revoke token approvals, visit:")}`,
      "",
      `${chalk.bold.cyan.underline(revokeLink)}`,
    ].join("\n"),
    {
      padding: { top: 1, bottom: 1, left: 3, right: 3 },
      margin: { top: 1, bottom: 1 },
      borderColor: "red",
      borderStyle: "double",
    }
  );

  console.log(helpContent);
  console.log(revokeLinkContent);

  // Wait for keypress to return
  process.stdin.once("data", () => {
    displayApprovalsList();
    process.stdout.write(chalk.cyan.bold("> "));
  });
}

// Interactive mode with improved prompting
function startInteractivePrompt() {
  // Use a visually distinct prompt
  process.stdout.write(chalk.cyan.bold("> "));

  // Use a different approach with process.stdin directly
  process.stdin.resume(); // Resume stdin stream
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", function (data) {
    const command = data.toString().trim().toLowerCase();

    if (command === "q") {
      console.log(chalk.green("Exiting..."));
      rl.close();
      process.exit(0);
    } else if (command === "n") {
      if (selectedApprovalIndex < approvalsList.length - 1) {
        selectedApprovalIndex++;
        // Update current page if selection moves to next page
        if (selectedApprovalIndex >= (currentPage + 1) * PAGE_SIZE) {
          currentPage = Math.floor(selectedApprovalIndex / PAGE_SIZE);
        }
      }
      displayApprovalsList();
      process.stdout.write(chalk.cyan.bold("> "));
    } else if (command === "p") {
      if (selectedApprovalIndex > 0) {
        selectedApprovalIndex--;
        // Update current page if selection moves to previous page
        if (selectedApprovalIndex < currentPage * PAGE_SIZE) {
          currentPage = Math.floor(selectedApprovalIndex / PAGE_SIZE);
        }
      }
      displayApprovalsList();
      process.stdout.write(chalk.cyan.bold("> "));
    } else if (command === ">") {
      // Next page
      if ((currentPage + 1) * PAGE_SIZE < approvalsList.length) {
        currentPage++;
        // Update selected index to first item on new page
        selectedApprovalIndex = currentPage * PAGE_SIZE;
      }
      displayApprovalsList();
      process.stdout.write(chalk.cyan.bold("> "));
    } else if (command === "<") {
      // Previous page
      if (currentPage > 0) {
        currentPage--;
        // Update selected index to first item on new page
        selectedApprovalIndex = currentPage * PAGE_SIZE;
      }
      displayApprovalsList();
      process.stdout.write(chalk.cyan.bold("> "));
    } else if (command === "h") {
      // Show help screen
      displayHelpScreen();
    } else if (command === "") {
      // Enter key - toggle details view
      detailsExpanded = !detailsExpanded;
      displayApprovalsList();
      process.stdout.write(chalk.cyan.bold("> "));
    } else if (command) {
      // Invalid command
      console.log(
        chalk.red(`Invalid command: '${command}'. Type 'h' for help.`)
      );
      process.stdout.write(chalk.cyan.bold("> "));
    } else {
      // Empty command, just redisplay prompt
      process.stdout.write(chalk.cyan.bold("> "));
    }
  });

  // Handle Ctrl+C to exit gracefully
  process.on("SIGINT", function () {
    console.log("\nExiting...");
    process.exit(0);
  });
}

// Main function
async function main() {
  // Clear the screen and show welcome message
  console.clear();
  console.log(chalk.bold.cyan(figlet.textSync("snubb", { font: "Doom" })));
  console.log(
    chalk.bold.cyan("multichain token approval scanner") +
      " - " +
      chalk.cyan("powered by ") +
      chalk.cyan.underline("envio.dev") +
      "\n"
  );
  console.log(chalk.yellow(`Address: ${chalk.green(TARGET_ADDRESS)}\n`));

  // Show which chains will be scanned
  console.log(chalk.yellow("Scanning chains:"));
  for (const chainId of CHAIN_IDS) {
    const chain = SUPPORTED_CHAINS[chainId] || {
      name: `Chain ${chainId}`,
      color: "white",
    };
    console.log(`  - ${formatChainName(chainId)}`);
  }
  console.log("");

  try {
    // Initialize chain statistics first (without spinner to show real-time progress)
    console.log(chalk.bold.yellow("INITIALIZING CHAINS"));

    // Get chain heights for all chains first
    for (const chainId of CHAIN_IDS) {
      // Initialize per-chain stats
      chainStats[chainId] = {
        height: 0,
        totalEvents: 0,
        startTime: 0,
        endTime: 0,
        progressBar: drawProgressBar(0),
        eventsPerSecond: 0,
        approvalsCount: 0,
        isScanning: false,
        isComplete: false,
      };

      // Initialize Hypersync client for this chain
      const hypersyncUrl = `http://${chainId}.hypersync.xyz`;
      try {
        const client = HypersyncClient.new({
          url: hypersyncUrl,
        });

        // Get chain height
        console.log(`  Connecting to ${formatChainName(chainId)}...`);
        const height = await client.getHeight();
        chainStats[chainId].height = height;
        console.log(
          `  ${formatChainName(chainId)} height: ${formatNumber(height)}`
        );
      } catch (error) {
        console.error(
          chalk.red(`  Error connecting to ${hypersyncUrl}: ${error.message}`)
        );
      }
    }

    console.log("\n" + chalk.bold.yellow("SCANNING PROGRESS"));

    // Display initial progress bars
    displayScanProgress();

    // Start scanning each chain (in parallel) but with UI updates
    const scanPromises = CHAIN_IDS.map((chainId) => {
      // Mark this chain as scanning
      chainStats[chainId].isScanning = true;
      chainStats[chainId].startTime = performance.now();

      // Return the scan promise
      return scanChain(chainId)
        .then((result) => {
          // Mark as complete and update UI
          chainStats[chainId].isScanning = false;
          chainStats[chainId].isComplete = true;
          displayScanProgress();
          return result;
        })
        .catch((error) => {
          // Handle error, mark as complete
          console.error(
            chalk.red(`Error scanning chain ${chainId}: ${error.message}`)
          );
          chainStats[chainId].isScanning = false;
          chainStats[chainId].isComplete = true;
          displayScanProgress();
          return { approvals: {}, transfersUsingApprovals: {} };
        });
    });

    // Start UI update interval - refresh every 500ms while scanning
    const uiUpdateInterval = setInterval(() => {
      // Only continue updating while at least one chain is still scanning
      if (Object.values(chainStats).some((stats) => stats.isScanning)) {
        displayScanProgress();
      } else {
        clearInterval(uiUpdateInterval);
      }
    }, 500);

    // Wait for all scans to complete
    const results = await Promise.all(scanPromises);

    // Clear the UI update interval (if not already cleared)
    clearInterval(uiUpdateInterval);

    // Show completion message
    console.log(chalk.green("\nAll chains scanned successfully!\n"));

    // Process approvals from all chains
    approvalsList = [];

    // Combine results from all chains
    results.forEach(({ approvals, transfersUsingApprovals }, index) => {
      const chainId = CHAIN_IDS[index];
      let chainApprovalsCount = 0;

      // Process approvals for this chain
      for (const tokenAddress in approvals) {
        for (const spender in approvals[tokenAddress]) {
          const {
            amount: approvedAmount,
            blockNumber,
            txHash,
          } = approvals[tokenAddress][spender];
          const transferredAmount =
            transfersUsingApprovals[tokenAddress]?.[spender] || BigInt(0);

          // Calculate remaining approval
          let remainingApproval;
          let isUnlimited = false;

          // Check for unlimited approval (common values)
          if (
            approvedAmount === BigInt(2) ** BigInt(256) - BigInt(1) ||
            approvedAmount ===
              BigInt(
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
              ) ||
            isEffectivelyUnlimited(approvedAmount)
          ) {
            remainingApproval = approvedAmount;
            isUnlimited = true;
          } else {
            remainingApproval =
              approvedAmount > transferredAmount
                ? approvedAmount - transferredAmount
                : BigInt(0);
          }

          // Only show non-zero remaining approvals
          if (remainingApproval > 0) {
            approvalsList.push({
              chainId,
              tokenAddress,
              spender,
              approvedAmount,
              transferredAmount,
              remainingApproval,
              isUnlimited,
              blockNumber,
              txHash,
            });
            chainApprovalsCount++;
          }
        }
      }

      // Update chain stats with approval count
      if (chainStats[chainId]) {
        chainStats[chainId].approvalsCount = chainApprovalsCount;
      }
    });

    // Sort approvals with priority: by chain, unlimited first across tokens, then largest amounts
    approvalsList.sort((a, b) => {
      // First by chain ID
      if (a.chainId !== b.chainId) {
        return a.chainId - b.chainId;
      }

      // Group by token + unlimited status to bring unlimited tokens to the top
      const aIsUnlimitedToken =
        a.isUnlimited || isEffectivelyUnlimited(a.remainingApproval);
      const bIsUnlimitedToken =
        b.isUnlimited || isEffectivelyUnlimited(b.remainingApproval);

      // Sort unlimited tokens first within the same chain
      if (aIsUnlimitedToken && !bIsUnlimitedToken) return -1;
      if (!aIsUnlimitedToken && bIsUnlimitedToken) return 1;

      // For tokens with the same unlimited status, sort by token address
      if (a.tokenAddress !== b.tokenAddress) {
        return a.tokenAddress.localeCompare(b.tokenAddress);
      }

      // Then by unlimited status (unlimited approvals first) for the same token
      if (a.isUnlimited && !b.isUnlimited) return -1;
      if (!a.isUnlimited && b.isUnlimited) return 1;

      // Then by remaining approval amount (highest first) for same token, non-unlimited approvals
      if (!a.isUnlimited && !b.isUnlimited) {
        if (b.remainingApproval > a.remainingApproval) return 1;
        if (b.remainingApproval < a.remainingApproval) return -1;
      }

      return 0;
    });

    // Display summary
    console.log(
      chalk.cyan(
        `Found ${chalk.white(
          approvalsList.length
        )} outstanding approvals for ${chalk.white(TARGET_ADDRESS)}\n`
      )
    );

    if (approvalsList.length === 0) {
      console.log(
        chalk.green("No outstanding approvals found. Your wallets are secure!")
      );
      rl.close();
      process.exit(0);
    }

    // Display initial approvals list
    displayApprovalsList();

    // Start interactive mode
    startInteractivePrompt();
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// Function to display ongoing scan progress
function displayScanProgress() {
  // No need to clear the screen - we want to see continuous updates

  // Calculate maximum width needed for chain names
  const chainNameWidth =
    Math.max(
      ...CHAIN_IDS.map((id) => formatChainName(id).length),
      10 // Minimum width
    ) + 2; // Add some padding

  // Display progress for each chain
  for (const chainId of CHAIN_IDS) {
    const stats = chainStats[chainId];
    if (!stats) continue;

    // If chain is actively scanning
    if (stats.isScanning) {
      const elapsedTime = (performance.now() - stats.startTime) / 1000;
      const eventsPerSecond =
        stats.totalEvents > 0 ? Math.round(stats.totalEvents / elapsedTime) : 0;

      // Format numbers with consistent width
      const blockDisplay = `${formatNumber(
        stats.lastBlockSeen || 0
      )}/${formatNumber(stats.height)}`.padEnd(20);
      const eventsDisplay = formatNumber(stats.totalEvents).padEnd(8);
      const speedDisplay = `${formatNumber(eventsPerSecond)}/s`.padEnd(10);

      // Calculate progress percentage - ensure it's greater than 0 if any blocks processed
      const progress = stats.lastBlockSeen
        ? Math.max(0.01, stats.lastBlockSeen / stats.height)
        : 0;

      // Update progress bar
      stats.progressBar = drawProgressBar(
        progress,
        40,
        SUPPORTED_CHAINS[chainId]?.color || "cyan"
      );

      // Use a different format for in-progress chains with better alignment
      process.stdout.write(
        `\r${formatChainName(chainId).padEnd(chainNameWidth)}: ${
          stats.progressBar
        } Block: ${blockDisplay} | Events: ${eventsDisplay} | ${speedDisplay}     `
      );
      process.stdout.write("\n");
    }
    // If chain scan is complete
    else if (stats.isComplete) {
      const elapsedTime = (stats.endTime / 1000).toFixed(1);

      // Format numbers with consistent width
      const eventsDisplay = formatNumber(stats.totalEvents).padEnd(8);
      const timeDisplay = `${elapsedTime}s`.padEnd(6);

      // Ensure progress bar shows 100% for completed chains
      stats.progressBar = drawProgressBar(
        1.0,
        40,
        SUPPORTED_CHAINS[chainId]?.color || "cyan"
      );

      // Show completed chain with checkmark and better alignment
      process.stdout.write(
        `\r${formatChainName(chainId).padEnd(chainNameWidth)}: ${
          stats.progressBar
        } ${chalk.green(
          "✓"
        )} Complete | Events: ${eventsDisplay} in ${timeDisplay}        `
      );
      process.stdout.write("\n");
    }
    // If not yet started scanning
    else {
      process.stdout.write(
        `\r${formatChainName(chainId).padEnd(chainNameWidth)}: ${
          stats.progressBar
        } Waiting to begin scan...        `
      );
      process.stdout.write("\n");
    }
  }

  // Move cursor position back up to overwrite the progress display on next update
  process.stdout.write(`\x1b[${CHAIN_IDS.length}A`);
}

// Function to scan a single chain
async function scanChain(chainId) {
  // Initialize per-chain stats (should already be initialized in main)
  const stats = chainStats[chainId];
  const chain = SUPPORTED_CHAINS[chainId] || {
    name: `Chain ${chainId}`,
    color: "white",
  };
  const colorName = chain.color || "white";

  // Initialize Hypersync client for this chain
  const hypersyncUrl = `http://${chainId}.hypersync.xyz`;
  const client = HypersyncClient.new({
    url: hypersyncUrl,
  });

  // Create decoder for events
  const decoder = Decoder.fromSignatures([
    "Transfer(address indexed from, address indexed to, uint256 amount)",
    "Approval(address indexed owner, address indexed spender, uint256 amount)",
  ]);

  // Track approvals by token and spender
  const approvals = {};
  const transfersUsingApprovals = {};

  let query = createQuery(0);
  let lastOutputTime = Date.now();

  // Start streaming events
  const stream = await client.stream(query, {});

  while (true) {
    try {
      const res = await stream.recv();

      // Exit if we've reached the end of the chain
      if (res === null) {
        break;
      }

      // Track the last block we've seen
      if (res.nextBlock) {
        stats.lastBlockSeen = res.nextBlock;
      }

      // Process events
      if (res.data && res.data.logs) {
        stats.totalEvents += res.data.logs.length;

        // Decode logs
        const decodedLogs = await decoder.decodeLogs(res.data.logs);

        // Process ERC20 events
        for (let i = 0; i < decodedLogs.length; i++) {
          const log = decodedLogs[i];
          if (log === null) continue;

          try {
            // Get the original raw log and transaction
            const rawLog = res.data.logs[i];
            if (!rawLog || !rawLog.topics || !rawLog.topics[0]) continue;

            const topic0 = rawLog.topics[0];
            const tokenAddress = rawLog.address.toLowerCase();

            // Find corresponding transaction for this log
            const txHash = rawLog.transactionHash;
            const transaction = res.data.transactions?.find(
              (tx) => tx.hash === txHash
            );
            const txSender = transaction?.from?.toLowerCase() || null;

            if (topic0 === APPROVAL_TOPIC) {
              // Get owner and spender from indexed parameters
              const owner = log.indexed[0]?.val.toString().toLowerCase() || "";
              const spender =
                log.indexed[1]?.val.toString().toLowerCase() || "";
              const amount = log.body[0]?.val || BigInt(0);

              // Only track approvals where the target address is the owner
              if (owner === TARGET_ADDRESS.toLowerCase()) {
                // Initialize token in approvals map if needed
                if (!approvals[tokenAddress]) {
                  approvals[tokenAddress] = {};
                }

                // Store latest approval with block number for chronological ordering
                approvals[tokenAddress][spender] = {
                  amount,
                  blockNumber: rawLog.blockNumber,
                  txHash,
                };
              }
            } else if (topic0 === TRANSFER_TOPIC) {
              // Get from and to from indexed parameters
              const from = log.indexed[0]?.val.toString().toLowerCase() || "";
              const to = log.indexed[1]?.val.toString().toLowerCase() || "";
              const amount = log.body[0]?.val || BigInt(0);

              // Track transfers where the target has approved a spender (from = target, to = any)
              if (from === TARGET_ADDRESS.toLowerCase()) {
                // Initialize token in transfers map if needed
                if (!transfersUsingApprovals[tokenAddress]) {
                  transfersUsingApprovals[tokenAddress] = {};
                }

                // Check two cases:
                // 1. Transaction initiated by spender (typical approval usage)
                // 2. Transaction initiated by owner but sent to a contract with approval
                const isSpenderInitiated =
                  txSender && txSender !== from.toLowerCase();
                const isOwnerInitiatedToSpender =
                  txSender === from.toLowerCase() && transaction?.to;

                if (isSpenderInitiated) {
                  // Track against the transaction sender (spender)
                  if (!transfersUsingApprovals[tokenAddress][txSender]) {
                    transfersUsingApprovals[tokenAddress][txSender] = BigInt(0);
                  }
                  transfersUsingApprovals[tokenAddress][txSender] += amount;
                } else if (isOwnerInitiatedToSpender) {
                  // When owner initiates a transaction to a spender
                  const txTo = transaction.to.toLowerCase();

                  // Check if txTo is an approved spender
                  if (approvals[tokenAddress]?.[txTo]) {
                    if (!transfersUsingApprovals[tokenAddress][txTo]) {
                      transfersUsingApprovals[tokenAddress][txTo] = BigInt(0);
                    }
                    transfersUsingApprovals[tokenAddress][txTo] += amount;
                  }
                }
              }
            }
          } catch (error) {
            // Silently ignore errors to prevent crashing
          }
        }
      }

      // Update query for next batch
      if (res.nextBlock) {
        query.fromBlock = res.nextBlock;
      }

      // Update progress display periodically
      const now = Date.now();
      if (now - lastOutputTime > 200) {
        // More frequent updates (200ms)
        const progress = Math.min(1, res.nextBlock / stats.height);
        const seconds = (performance.now() - stats.startTime) / 1000;
        stats.eventsPerSecond = Math.round(stats.totalEvents / seconds);

        // Update progress bar using safe color
        stats.progressBar = drawProgressBar(progress, 40, colorName);

        lastOutputTime = now;
      }
    } catch (error) {
      // Log error but continue processing
      console.error(
        chalk.red(`Error processing chain ${chainId}: ${error.message}`)
      );
    }
  }

  // Processing complete
  stats.endTime = performance.now() - stats.startTime;

  // Ensure progress is 100% when complete
  stats.progressBar = drawProgressBar(1.0, 40, colorName);

  return { approvals, transfersUsingApprovals };
}

// Run the main function with error handling
main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${error.message}`));
  process.exit(1);
});
