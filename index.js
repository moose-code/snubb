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

// Import extraRpcs dynamically
let extraRpcs = {};
try {
  const extraRpcsPath = path.resolve("./extraRpcs.js");
  if (fs.existsSync(extraRpcsPath)) {
    const module = await import(extraRpcsPath);
    extraRpcs = module.default || {};
  }
} catch (error) {
  console.warn(
    chalk.yellow(`Warning: Could not load extraRpcs.js: ${error.message}`)
  );
}

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

// Fetch token metadata from a list of RPCs with retry logic
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

  // Add fallback RPCs based on known networks
  if (chainId === 1 && rpcUrls.length === 0) {
    rpcUrls = ["https://rpc.ankr.com/eth", "https://eth.llamarpc.com"];
  }

  // If no RPCs available, return default values
  if (rpcUrls.length === 0) {
    return { success: false, name: null, symbol: null, decimals: 18 };
  }

  // Try each RPC until one works
  for (const rpcUrl of rpcUrls) {
    try {
      if (rpcUrl.startsWith("wss://")) continue; // Skip WebSocket RPCs for now

      // Create a viem client
      const client = createPublicClient({
        chain: mainnet, // This is just for typing, we'll override with custom endpoint
        transport: http(rpcUrl),
      });

      // Fetch token metadata (name, symbol, decimals)
      const [name, symbol, decimals] = await Promise.all([
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "name",
          })
          .catch(() => "Unknown Token"),
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "symbol",
          })
          .catch(() => "???"),
        client
          .readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "decimals",
          })
          .catch(() => 18),
      ]);

      const metadata = {
        success: true,
        name,
        symbol,
        decimals,
        formattedName: `${name} (${symbol})`,
      };

      // Cache the result
      tokenMetadataCache.set(cacheKey, metadata);
      return metadata;
    } catch (error) {
      // Continue to the next RPC if this one fails
      continue;
    }
  }

  // If all RPCs failed, return default values
  return { success: false, name: null, symbol: null, decimals: 18 };
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
let scanStats = {
  totalEvents: 0,
  totalApprovals: 0,
  startTime: 0,
  endTime: 0,
  height: 0,
  progressBar: "",
  eventsPerSecond: 0,
};

// Create global readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

// CLI setup
const program = new Command();
program
  .name("revoke-approvals")
  .description("Terminal UI for finding and revoking Ethereum token approvals")
  .version("1.0.0")
  .option("-a, --address <address>", "Ethereum address to check approvals for")
  .option("-c, --chain <chainId>", "Chain ID to scan (default: 1)", "1")
  .parse(process.argv);

const options = program.opts();

// Check if we have an address
let TARGET_ADDRESS = options.address;
if (!TARGET_ADDRESS) {
  console.log(
    chalk.bold.cyan(
      figlet.textSync("Revoke", {
        font: "ANSI Shadow",
        horizontalLayout: "full",
      })
    )
  );
  console.log(chalk.bold.cyan("A beautiful Ethereum approval scanner\n"));

  console.log(chalk.yellow("Usage:"));
  console.log(
    chalk.green(
      "  revoke-approvals --address 0x7C25a8C86A04f40F2Db0434ab3A24b051FB3cA58\n"
    )
  );
  console.log(chalk.yellow("Options:"));
  console.log(
    chalk.green(
      "  --chain <chainId>  Chain ID to scan (default: 1 for Ethereum mainnet)\n"
    )
  );

  process.exit(0);
}

// Get chain ID from options
const CHAIN_ID = parseInt(options.chain);

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

// Draw progress bar
function drawProgressBar(progress, width = 40) {
  const filledWidth = Math.floor(width * progress);
  const emptyWidth = width - filledWidth;
  const filledBar = "█".repeat(filledWidth);
  const emptyBar = "░".repeat(emptyWidth);
  return `[${chalk.cyan(filledBar)}${emptyBar}] ${(progress * 100).toFixed(
    2
  )}%`;
}

// Initialize Hypersync client
const client = HypersyncClient.new({
  url: "http://eth.hypersync.xyz",
});

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

// Function to display the approvals list
async function displayApprovalsList() {
  console.clear();

  // Display header with logo and stats
  console.log(
    chalk.bold.cyan(figlet.textSync("REVOKE", { font: "ANSI Shadow" }))
  );
  console.log(chalk.bold.cyan("Ethereum Token Approval Scanner\n"));

  // Display scan statistics in a box
  const statsContent = [
    `${chalk.yellow("Address:")} ${chalk.green(TARGET_ADDRESS)}`,
    `${chalk.yellow("Chain ID:")} ${chalk.white(CHAIN_ID)}`,
    `${chalk.yellow("Chain Height:")} ${chalk.white(
      formatNumber(scanStats.height)
    )}`,
    `${chalk.yellow("Events Processed:")} ${chalk.white(
      formatNumber(scanStats.totalEvents)
    )}`,
    `${chalk.yellow("Scan Time:")} ${chalk.white(
      (scanStats.endTime / 1000).toFixed(1)
    )} seconds`,
    `${chalk.yellow("Speed:")} ${chalk.white(
      formatNumber(scanStats.eventsPerSecond)
    )}/s`,
    `${chalk.yellow("Approvals Found:")} ${chalk.white(approvalsList.length)}`,
  ].join("\n");

  console.log(
    boxen(statsContent, {
      padding: 1,
      margin: { top: 0, bottom: 1 },
      borderStyle: "round",
      borderColor: "cyan",
    })
  );

  // Show progress bar (completed)
  console.log(scanStats.progressBar + " " + chalk.green("✓ Complete\n"));

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

  // Create a table-like structure for approvals with grouped tokens
  console.log(
    chalk.bold(
      `  ${chalk.cyan("TOKEN/SPENDER")}${" ".repeat(44)}${chalk.magenta(
        "AMOUNT"
      )}`
    )
  );
  console.log("  " + "─".repeat(70));

  // Group approvals by token for the current page
  let currentTokenAddress = null;

  // Display the approvals with token metadata when available
  for (let i = startIdx; i < endIdx; i++) {
    const approval = approvalsList[i];
    const isSelected = i === selectedApprovalIndex;

    // Check if this is a new token
    const isNewToken = currentTokenAddress !== approval.tokenAddress;
    if (isNewToken) {
      // Try to get token metadata from cache first
      const tokenMetadata = tokenMetadataCache.get(
        `${CHAIN_ID}:${approval.tokenAddress}`
      );

      // Print token with name if available, otherwise use address
      const tokenDisplay =
        tokenMetadata && tokenMetadata.success
          ? `${chalk.cyan.bold(tokenMetadata.name)} (${chalk.cyan(
              tokenMetadata.symbol
            )})`
          : chalk.cyan.bold(approval.tokenAddress);

      console.log(`  ${tokenDisplay}`);
      currentTokenAddress = approval.tokenAddress;
    }

    // Update unlimited flag for effectively unlimited values
    const isEffectiveUnlimited = isEffectivelyUnlimited(
      approval.remainingApproval
    );
    const displayAsUnlimited = approval.isUnlimited || isEffectiveUnlimited;

    // Indent spenders under their token
    const prefix = isSelected ? chalk.cyan("→ ") : "    ";
    const spenderPart = isSelected
      ? chalk.yellow.bold(formatToken(approval.spender))
      : chalk.yellow(formatToken(approval.spender));

    // Get token metadata from cache if available for amount formatting
    const tokenMetadata = tokenMetadataCache.get(
      `${CHAIN_ID}:${approval.tokenAddress}`
    );

    const amountPart = displayAsUnlimited
      ? chalk.red.bold(isSelected ? "⚠️ UNLIMITED" : "⚠️ ∞")
      : chalk.green(formatAmount(approval.remainingApproval, tokenMetadata));

    // Pad spaces to align columns
    const spenderSpacer = " ".repeat(
      Math.max(2, 50 - formatToken(approval.spender).length)
    );

    // Use different indentation for spenders
    console.log(`${prefix}${spenderPart}${spenderSpacer}${amountPart}`);
  }

  console.log("\n" + chalk.dim("  ℹ️  Select an approval to see details"));

  // Display details of the selected approval
  if (approvalsList.length > 0) {
    const approval = approvalsList[selectedApprovalIndex];

    // Use cached token metadata if available
    const tokenMetadata = tokenMetadataCache.get(
      `${CHAIN_ID}:${approval.tokenAddress}`
    );

    // Display approval details with available metadata
    displayApprovalDetails(approval, tokenMetadata || { success: false });
  }

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

// Asynchronous function to fetch token metadata in background
async function fetchTokenMetadataInBackground(startIdx, endIdx) {
  // Collection of unique token addresses on the current page
  const tokensToFetch = new Set();

  // Collect all tokens that need metadata
  for (let i = startIdx; i < endIdx; i++) {
    if (i < approvalsList.length) {
      const tokenAddress = approvalsList[i].tokenAddress;
      const cacheKey = `${CHAIN_ID}:${tokenAddress}`;

      // Only fetch tokens that aren't already in the cache
      if (!tokenMetadataCache.has(cacheKey)) {
        tokensToFetch.add(tokenAddress);
      }
    }
  }

  // If no tokens to fetch, we're done
  if (tokensToFetch.size === 0) return;

  // Fetch token metadata in parallel
  const promises = Array.from(tokensToFetch).map(async (tokenAddress) => {
    await fetchTokenMetadata(tokenAddress, CHAIN_ID);
  });

  // Wait for all fetches to complete then redraw the screen
  await Promise.all(promises);
  displayApprovalsList();
}

// Function to display approval details
function displayApprovalDetails(approval, tokenMetadata) {
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

  console.log(
    chalk.bold.cyan(figlet.textSync("HELP", { font: "ANSI Shadow" }))
  );
  console.log(chalk.bold.cyan("Ethereum Token Approval Scanner\n"));

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

  console.log(helpContent);

  // Wait for keypress to return
  process.stdin.once("data", () => {
    displayApprovalsList();
    process.stdout.write("> ");
  });
}

// Interactive mode with improved prompting
function startInteractivePrompt() {
  // Interactive mode indicator is now moved into the navigation box at the bottom of displayApprovalsList

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
  console.log(
    chalk.bold.cyan(figlet.textSync("REVOKE", { font: "ANSI Shadow" }))
  );
  console.log(chalk.bold.cyan("Ethereum Token Approval Scanner\n"));
  console.log(chalk.yellow(`Address: ${chalk.green(TARGET_ADDRESS)}\n`));

  // Initialize spinner
  let spinner = ora({
    text: "Connecting to Ethereum...",
    color: "cyan",
  }).start();

  try {
    // Get chain height for progress tracking
    const height = await client.getHeight();
    scanStats.height = height; // Store for later use
    spinner.succeed(
      `Connected to Ethereum. Chain height: ${formatNumber(height)}`
    );

    // Create decoder for events
    const decoder = Decoder.fromSignatures([
      "Transfer(address indexed from, address indexed to, uint256 amount)",
      "Approval(address indexed owner, address indexed spender, uint256 amount)",
    ]);

    // Track approvals by token and spender
    const approvals = {};
    const transfersUsingApprovals = {};
    const tokenAddresses = new Set();
    const tokenCounts = {};

    let totalEvents = 0;
    let totalApprovals = 0;
    let startTime = performance.now();
    scanStats.startTime = startTime; // Store for later display
    let query = createQuery(0);

    // Initial progress display
    console.log(
      chalk.cyan(
        `\nScanning from block ${chalk.white("0")} to ${chalk.white(
          formatNumber(height)
        )}`
      )
    );
    console.log(drawProgressBar(0) + ` Block: 0/${formatNumber(height)}`);

    // Start streaming events
    const stream = await client.stream(query, {});

    // For updating status line periodically
    let lastOutputTime = Date.now();

    while (true) {
      const res = await stream.recv();

      // Exit if we've reached the end of the chain
      if (res === null) {
        process.stdout.write("\r" + " ".repeat(100) + "\r"); // Clear line
        console.log(chalk.green("✓ Reached the tip of the blockchain!"));
        break;
      }

      // Process events
      if (res.data && res.data.logs) {
        totalEvents += res.data.logs.length;
        scanStats.totalEvents = totalEvents; // Update global stats

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
            tokenAddresses.add(tokenAddress);

            // Track token counts
            if (!tokenCounts[tokenAddress]) {
              tokenCounts[tokenAddress] = 0;
            }
            tokenCounts[tokenAddress]++;

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

                totalApprovals++;
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
      if (now - lastOutputTime > 300) {
        // Update every 300ms maximum
        const progress = Math.min(1, res.nextBlock / height);
        const seconds = (performance.now() - startTime) / 1000;
        const eventsPerSecond = Math.round(totalEvents / seconds);
        scanStats.eventsPerSecond = eventsPerSecond; // Update global stats

        // Save current progress bar to global state
        scanStats.progressBar = drawProgressBar(progress);

        // Clear line and update progress
        process.stdout.write("\r" + " ".repeat(100) + "\r");
        process.stdout.write(
          `${scanStats.progressBar} Block: ${formatNumber(
            res.nextBlock
          )}/${formatNumber(height)} | ` +
            `Events: ${formatNumber(totalEvents)} | ` +
            `Speed: ${formatNumber(eventsPerSecond)}/s`
        );

        lastOutputTime = now;
      }
    }

    // Processing complete
    scanStats.endTime = performance.now() - startTime;

    console.log(
      chalk.green(
        `\n✨ Scan complete: ${formatNumber(
          totalEvents
        )} events in ${scanStats.endTime.toFixed(1)} seconds\n`
      )
    );

    // Process and display approvals
    approvalsList = [];

    // Prepare approvals for display
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
            tokenAddress,
            spender,
            approvedAmount,
            transferredAmount,
            remainingApproval,
            isUnlimited,
            blockNumber,
            txHash,
          });
        }
      }
    }

    // Sort approvals with priority: unlimited first, then by amount (largest to smallest), then by token
    approvalsList.sort((a, b) => {
      // First by unlimited status (unlimited first)
      if (a.isUnlimited && !b.isUnlimited) return -1;
      if (!a.isUnlimited && b.isUnlimited) return 1;

      // Then by remaining approval amount (highest first)
      if (!a.isUnlimited && !b.isUnlimited) {
        if (b.remainingApproval > a.remainingApproval) return 1;
        if (b.remainingApproval < a.remainingApproval) return -1;
      }

      // Finally by token address
      return a.tokenAddress.localeCompare(b.tokenAddress);
    });

    // Group approvals by token (for display)
    groupedApprovals = approvalsList.reduce((groups, approval) => {
      const { tokenAddress } = approval;
      if (!groups[tokenAddress]) {
        groups[tokenAddress] = [];
      }
      groups[tokenAddress].push(approval);
      return groups;
    }, {});

    // Reorder the flat list to ensure tokens are grouped together
    // while maintaining the priority order within each token group
    const newOrderedList = [];

    // Get unique token addresses in the order they first appear in the sorted list
    const tokenOrder = [];
    approvalsList.forEach((approval) => {
      if (!tokenOrder.includes(approval.tokenAddress)) {
        tokenOrder.push(approval.tokenAddress);
      }
    });

    // Build new ordered list preserving inner sorting but grouping by token
    tokenOrder.forEach((tokenAddress) => {
      const approvalsForToken = groupedApprovals[tokenAddress];
      // Sort approvals within each token group: unlimited first, then by amount
      approvalsForToken.sort((a, b) => {
        // First by unlimited status
        if (a.isUnlimited && !b.isUnlimited) return -1;
        if (!a.isUnlimited && b.isUnlimited) return 1;

        // Then by remaining approval amount
        return b.remainingApproval > a.remainingApproval ? 1 : -1;
      });

      newOrderedList.push(...approvalsForToken);
    });

    // Replace original list with regrouped list
    approvalsList = newOrderedList;

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
        chalk.green("No outstanding approvals found. Your wallet is secure!")
      );
      rl.close();
      process.exit(0);
    }

    // Display initial approvals list
    displayApprovalsList();

    // Start interactive mode
    console.log(chalk.yellow.bold("\nStarting interactive mode..."));
    console.log(
      chalk.yellow("(If commands don't work, try pressing Enter first)\n")
    );

    startInteractivePrompt();

    // Explicitly don't exit - the startInteractivePrompt will handle that
  } catch (error) {
    spinner.fail("Error");
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// Run the main function with error handling
main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${error.message}`));
  process.exit(1);
});
