// ============================================================
//  RISC-V RV32I CPU Core
// ============================================================

class RISCVCore {
    constructor() {
        this.MEM_SIZE   = 0x30000; // 192KB total
        this.TEXT_BASE  = 0x0000;
        this.DATA_BASE  = 0x4000;
        this.STACK_INIT = 0x2FFE0; // top of stack

        this.memory  = new Uint8Array(this.MEM_SIZE);
        this.regs    = new Int32Array(32);
        this.pc      = 0;
        this.running = false;
        this.halted  = false;
        this.cycleCount = 0;

        // Console callback (set by UI)
        this.onOutput   = null;
        this.onHalt     = null;
        this.onBreak    = null;

        // Track what changed last step
        this.lastChangedRegs = new Set();
        this.lastMemWrite    = null;
        this.lastInstrWord   = 0;
        this.lastInstrPC     = 0;
        this.lastInstrInfo   = null; // { asm, type, ... }
    }

    // ─── Reset CPU ────────────────────────────────────────────
    reset() {
        this.memory.fill(0);
        this.regs.fill(0);
        this.regs[2]    = this.STACK_INIT; // sp
        this.pc         = this.TEXT_BASE;
        this.running    = false;
        this.halted     = false;
        this.cycleCount = 0;
        this.lastChangedRegs.clear();
        this.lastMemWrite    = null;
        this.lastInstrWord   = 0;
        this.lastInstrPC     = 0;
        this.lastInstrInfo   = null;
    }

    // ─── Load assembled program into memory ───────────────────
    loadProgram(instructions, dataSegment) {
        this.reset();

        // Load instructions into text segment
        for (const { addr, word } of instructions) {
            this._storeWord(addr, word);
        }

        // Load data segment
        for (const { addr, bytes } of dataSegment) {
            for (let i = 0; i < bytes.length; i++) {
                if (addr + i < this.MEM_SIZE) {
                    this.memory[addr + i] = bytes[i] & 0xFF;
                }
            }
        }
    }

    // ─── Execute one instruction ──────────────────────────────
    step(assembler) {
        if (this.halted) return { halted: true };

        this.lastChangedRegs.clear();
        this.lastMemWrite = null;

        const pc   = this.pc;
        const word = this._loadWord(pc);
        this.lastInstrWord = word;
        this.lastInstrPC   = pc;

        // Decode for display
        if (assembler) {
            this.lastInstrInfo = assembler.decode(word, pc);
        }

        const result = this._execute(word, pc);
        this.cycleCount++;

        return result;
    }

    // ─── Internal execute ─────────────────────────────────────
    _execute(word, pc) {
        const op   = word & 0x7F;
        const rd   = (word >> 7)  & 0x1F;
        const f3   = (word >> 12) & 0x7;
        const rs1n = (word >> 15) & 0x1F;
        const rs2n = (word >> 20) & 0x1F;
        const f7   = (word >> 25) & 0x7F;

        const rs1  = this.regs[rs1n];  // signed 32-bit
        const rs2  = this.regs[rs2n];
        const rs1u = rs1 >>> 0;         // unsigned
        const rs2u = rs2 >>> 0;

        const iImm12 = word >> 20;          // arithmetic right-shift for sign ext
        const iImm   = (iImm12 << 20) >> 20; // sign-extend from bit 11

        const sImm = (((word >> 25) & 0x7F) << 5) | ((word >> 7) & 0x1F);
        const sImmS = (sImm << 20) >> 20;

        const bOff = this._decodeBImm(word);
        const uImm = word & 0xFFFFF000;

        const jOff = this._decodeJImm(word);

        let nextPC = pc + 4;
        let written = false;

        const writeRd = (val) => {
            if (rd !== 0) {
                const prev = this.regs[rd];
                this.regs[rd] = val | 0;
                if (this.regs[rd] !== prev) this.lastChangedRegs.add(rd);
            }
            written = true;
        };

        switch (op) {
            // ── R-type ──────────────────────────────────────
            case 0b0110011:
                switch ((f7 << 3) | f3) {
                    case 0b0000000_000: writeRd(rs1 + rs2); break;          // ADD
                    case 0b0100000_000: writeRd(rs1 - rs2); break;          // SUB
                    case 0b0000000_001: writeRd(rs1 << (rs2 & 0x1F)); break;// SLL
                    case 0b0000000_010: writeRd(rs1 < rs2 ? 1 : 0); break;  // SLT
                    case 0b0000000_011: writeRd(rs1u < rs2u ? 1 : 0); break;// SLTU
                    case 0b0000000_100: writeRd(rs1 ^ rs2); break;          // XOR
                    case 0b0000000_101: writeRd(rs1u >>> (rs2 & 0x1F)); break;// SRL
                    case 0b0100000_101: writeRd(rs1 >> (rs2 & 0x1F)); break; // SRA
                    case 0b0000000_110: writeRd(rs1 | rs2); break;          // OR
                    case 0b0000000_111: writeRd(rs1 & rs2); break;          // AND
                    default: return this._trap(`Illegal R-type funct7=${f7} funct3=${f3}`);
                }
                break;

            // ── I-type ALU ──────────────────────────────────
            case 0b0010011:
                switch (f3) {
                    case 0: writeRd(rs1 + iImm); break;                     // ADDI
                    case 2: writeRd(rs1 < iImm ? 1 : 0); break;             // SLTI
                    case 3: writeRd(rs1u < (iImm >>> 0) ? 1 : 0); break;    // SLTIU
                    case 4: writeRd(rs1 ^ iImm); break;                     // XORI
                    case 6: writeRd(rs1 | iImm); break;                     // ORI
                    case 7: writeRd(rs1 & iImm); break;                     // ANDI
                    case 1: writeRd(rs1 << (iImm & 0x1F)); break;           // SLLI
                    case 5:
                        if (f7 === 0b0100000) writeRd(rs1 >> (iImm & 0x1F));    // SRAI
                        else                  writeRd(rs1u >>> (iImm & 0x1F));   // SRLI
                        break;
                    default: return this._trap(`Illegal I-ALU funct3=${f3}`);
                }
                break;

            // ── LUI ─────────────────────────────────────────
            case 0b0110111:
                writeRd(uImm);
                break;

            // ── AUIPC ────────────────────────────────────────
            case 0b0010111:
                writeRd(pc + uImm);
                break;

            // ── Load ─────────────────────────────────────────
            case 0b0000011: {
                const addr = (rs1 + iImm) >>> 0;
                switch (f3) {
                    case 0: writeRd(this._loadByteSigned(addr)); break;   // LB
                    case 1: writeRd(this._loadHalfSigned(addr)); break;   // LH
                    case 2: writeRd(this._loadWordSigned(addr)); break;   // LW
                    case 4: writeRd(this._loadByte(addr)); break;         // LBU
                    case 5: writeRd(this._loadHalf(addr)); break;         // LHU
                    default: return this._trap(`Illegal load funct3=${f3}`);
                }
                break;
            }

            // ── Store ────────────────────────────────────────
            case 0b0100011: {
                const addr = (rs1 + sImmS) >>> 0;
                switch (f3) {
                    case 0: this._storeByte(addr, rs2); break;   // SB
                    case 1: this._storeHalf(addr, rs2); break;   // SH
                    case 2: this._storeWord(addr, rs2); break;   // SW
                    default: return this._trap(`Illegal store funct3=${f3}`);
                }
                this.lastMemWrite = addr;
                break;
            }

            // ── Branch ───────────────────────────────────────
            case 0b1100011: {
                let taken = false;
                switch (f3) {
                    case 0: taken = rs1 === rs2; break;         // BEQ
                    case 1: taken = rs1 !== rs2; break;         // BNE
                    case 4: taken = rs1 < rs2; break;           // BLT
                    case 5: taken = rs1 >= rs2; break;          // BGE
                    case 6: taken = rs1u < rs2u; break;         // BLTU
                    case 7: taken = rs1u >= rs2u; break;        // BGEU
                    default: return this._trap(`Illegal branch funct3=${f3}`);
                }
                if (taken) nextPC = pc + bOff;
                break;
            }

            // ── JAL ──────────────────────────────────────────
            case 0b1101111:
                writeRd(pc + 4);
                nextPC = pc + jOff;
                break;

            // ── JALR ─────────────────────────────────────────
            case 0b1100111:
                writeRd(pc + 4);
                nextPC = (rs1 + iImm) & ~1;
                break;

            // ── System ───────────────────────────────────────
            case 0b1110011:
                if (iImm === 0) return this._ecall();   // ECALL
                if (iImm === 1) return this._ebreak();  // EBREAK
                return this._trap(`Unknown system call imm=${iImm}`);

            default:
                return this._trap(`Illegal opcode: 0b${op.toString(2).padStart(7,'0')}`);
        }

        // x0 is always 0
        this.regs[0] = 0;
        this.pc = nextPC;

        return { halted: false, trap: null };
    }

    // ─── ECALL handler ────────────────────────────────────────
    _ecall() {
        const a7 = this.regs[17]; // syscall number in a7
        const a0 = this.regs[10];
        switch (a7) {
            case 1:  // print int
                if (this.onOutput) this.onOutput(String(a0), 'int');
                break;
            case 4:  // print string
                if (this.onOutput) {
                    let s = '';
                    let addr = a0 >>> 0;
                    while (addr < this.MEM_SIZE && this.memory[addr] !== 0) {
                        s += String.fromCharCode(this.memory[addr++]);
                        if (s.length > 4096) break;
                    }
                    this.onOutput(s, 'str');
                }
                break;
            case 10: // exit
                this.halted = true;
                if (this.onHalt) this.onHalt(a0);
                return { halted: true, exitCode: a0 };
            case 11: // print char
                if (this.onOutput) this.onOutput(String.fromCharCode(a0 & 0xFF), 'char');
                break;
            case 34: // print hex
                if (this.onOutput) this.onOutput('0x' + (a0 >>> 0).toString(16).padStart(8,'0'), 'hex');
                break;
            case 35: // print binary
                if (this.onOutput) this.onOutput('0b' + (a0 >>> 0).toString(2).padStart(32,'0'), 'bin');
                break;
            default:
                if (this.onOutput) this.onOutput(`[ecall a7=${a7}]`, 'warn');
        }
        this.pc += 4;
        return { halted: false, trap: null };
    }

    _ebreak() {
        if (this.onBreak) this.onBreak(this.pc);
        this.pc += 4;
        return { halted: false, trap: 'EBREAK' };
    }

    _trap(msg) {
        this.halted = true;
        const err = `TRAP at PC=0x${this.pc.toString(16).padStart(8,'0')}: ${msg}`;
        if (this.onOutput) this.onOutput(err, 'error');
        if (this.onHalt) this.onHalt(-1);
        return { halted: true, trap: err };
    }

    // ─── Immediate decoders ───────────────────────────────────
    _decodeBImm(word) {
        const b12  = (word >> 31) & 1;
        const b11  = (word >> 7) & 1;
        const b10_5 = (word >> 25) & 0x3F;
        const b4_1  = (word >> 8) & 0xF;
        const raw   = (b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1);
        return raw >= 0x1000 ? raw - 0x2000 : raw;
    }

    _decodeJImm(word) {
        const b20   = (word >> 31) & 1;
        const b10_1 = (word >> 21) & 0x3FF;
        const b11   = (word >> 20) & 1;
        const b19_12 = (word >> 12) & 0xFF;
        const raw   = (b20 << 20) | (b19_12 << 12) | (b11 << 11) | (b10_1 << 1);
        return raw >= 0x100000 ? raw - 0x200000 : raw;
    }

    // ─── Memory access helpers ────────────────────────────────
    _checkAddr(addr) {
        if (addr < 0 || addr >= this.MEM_SIZE) {
            this._trap(`Memory access out of bounds: 0x${(addr>>>0).toString(16)}`);
            return false;
        }
        return true;
    }

    _loadByte(addr)  { addr >>>= 0; return this._checkAddr(addr) ? this.memory[addr] : 0; }
    _loadHalf(addr)  { addr >>>= 0; return this._checkAddr(addr+1) ? (this.memory[addr] | (this.memory[addr+1] << 8)) : 0; }
    _loadWord(addr)  {
        addr >>>= 0;
        if (!this._checkAddr(addr+3)) return 0;
        return (this.memory[addr] | (this.memory[addr+1] << 8) |
                (this.memory[addr+2] << 16) | (this.memory[addr+3] << 24)) | 0;
    }
    _loadWordSigned(addr) { return this._loadWord(addr); }
    _loadByteSigned(addr) { const b = this._loadByte(addr); return b >= 128 ? b - 256 : b; }
    _loadHalfSigned(addr) { const h = this._loadHalf(addr); return h >= 32768 ? h - 65536 : h; }

    _storeByte(addr, val) { addr >>>= 0; if (this._checkAddr(addr)) this.memory[addr] = val & 0xFF; }
    _storeHalf(addr, val) {
        addr >>>= 0;
        if (this._checkAddr(addr+1)) {
            this.memory[addr]   = val & 0xFF;
            this.memory[addr+1] = (val >> 8) & 0xFF;
        }
    }
    _storeWord(addr, val) {
        addr >>>= 0;
        if (this._checkAddr(addr+3)) {
            this.memory[addr]   = val & 0xFF;
            this.memory[addr+1] = (val >> 8) & 0xFF;
            this.memory[addr+2] = (val >> 16) & 0xFF;
            this.memory[addr+3] = (val >> 24) & 0xFF;
        }
    }

    // ─── Public accessors ─────────────────────────────────────
    getRegisters()    { return new Int32Array(this.regs); }
    getPC()           { return this.pc; }
    getMemorySlice(start, len) {
        const end = Math.min(start + len, this.MEM_SIZE);
        return this.memory.slice(start, end);
    }
    isHalted()        { return this.halted; }
    getCycleCount()   { return this.cycleCount; }
}

// RISC-V ABI register names
const REG_ABI_NAMES = [
    'zero','ra','sp','gp','tp',
    't0','t1','t2',
    's0/fp','s1',
    'a0','a1','a2','a3','a4','a5','a6','a7',
    's2','s3','s4','s5','s6','s7','s8','s9','s10','s11',
    't3','t4','t5','t6'
];
