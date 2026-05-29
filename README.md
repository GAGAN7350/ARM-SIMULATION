# G_HCORE_SIM — RISC-V RV32I Hardware Simulator

> A fully-featured, browser-based **RISC-V RV32I** microprocessor simulator with a visual, step-by-step execution engine, register file viewer, memory hex dump, instruction decoder, and an integrated assembly editor powered by CodeMirror.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔧 **Assembler** | Two-pass RISC-V RV32I assembler supporting labels, pseudo-instructions, and `.data`/`.text` sections |
| ⚡ **Core Simulator** | Cycle-accurate RV32I instruction execution (R, I, S, B, U, J types) |
| 📝 **Assembly Editor** | Syntax-highlighted editor via CodeMirror with RISC-V keyword support |
| 📊 **Register File** | Live view of all 32 general-purpose registers (x0–x31) with ABI names |
| 🔍 **Instruction Decoder** | Detailed per-instruction decode panel showing opcode fields |
| 🗂️ **Memory Viewer** | Hex + ASCII dump with navigation controls |
| 🖥️ **Console Output** | `ecall`-based I/O: print int, print string, print char, exit |
| ⏱️ **Speed Control** | Adjustable simulation speed from 0.5 Hz to 10,000 Hz |
| 📋 **Example Programs** | Built-in example programs to get started instantly |

---

## 🚀 Getting Started

No build step required. Just open `index.html` in any modern browser.

```bash
git clone https://github.com/<your-username>/G_HCORE_SIM.git
cd G_HCORE_SIM
# Open index.html in your browser
start index.html        # Windows
open index.html         # macOS
xdg-open index.html     # Linux
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Enter` | Assemble source code |
| `Ctrl + Shift + Enter` | Run / Pause simulation |
| `F5` | Step (execute one instruction) |
| `Ctrl + R` | Reset simulation |

---

## 📁 Project Structure

```
G_HCORE_SIM/
├── index.html          # Main application shell
├── style.css           # Dark-theme UI styles
├── report.html         # Detailed project report
└── src/
    ├── assembler.js    # Two-pass RISC-V assembler
    ├── riscv_core.js   # RV32I CPU core & memory model
    ├── editor.js       # CodeMirror editor integration
    └── ui.js           # UI rendering & control logic
```

---

## 🛠️ Supported Instructions

**RV32I Base Integer Instruction Set:**

- **R-type**: `add`, `sub`, `and`, `or`, `xor`, `sll`, `srl`, `sra`, `slt`, `sltu`
- **I-type**: `addi`, `andi`, `ori`, `xori`, `slli`, `srli`, `srai`, `slti`, `sltiu`, `lw`, `lh`, `lb`, `lhu`, `lbu`, `jalr`
- **S-type**: `sw`, `sh`, `sb`
- **B-type**: `beq`, `bne`, `blt`, `bge`, `bltu`, `bgeu`
- **U-type**: `lui`, `auipc`
- **J-type**: `jal`
- **System**: `ecall`, `ebreak`
- **Pseudo**: `li`, `la`, `mv`, `nop`, `ret`, `call`, `j`, `beqz`, `bnez`, `blez`, `bgez`, `bltz`, `bgtz`

---

## 📜 ecall Interface

| `a7` value | Action |
|---|---|
| `1` | Print integer in `a0` |
| `4` | Print null-terminated string at address in `a0` |
| `10` | Exit program |
| `11` | Print character (ASCII) in `a0` |

---

## 📄 License

MIT License — feel free to use, modify, and share.

---

*Built with ❤️ — G_HCORE_SIM*
