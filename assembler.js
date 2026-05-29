// ============================================================
//  RISC-V RV32I Two-Pass Assembler
// ============================================================

class RISCVAssembler {
    constructor() {
        this.REGS = {
            'zero':0,'x0':0,'ra':1,'x1':1,'sp':2,'x2':2,'gp':3,'x3':3,
            'tp':4,'x4':4,'t0':5,'x5':5,'t1':6,'x6':6,'t2':7,'x7':7,
            's0':8,'fp':8,'x8':8,'s1':9,'x9':9,
            'a0':10,'x10':10,'a1':11,'x11':11,'a2':12,'x12':12,
            'a3':13,'x13':13,'a4':14,'x14':14,'a5':15,'x15':15,
            'a6':16,'x16':16,'a7':17,'x17':17,
            's2':18,'x18':18,'s3':19,'x19':19,'s4':20,'x20':20,
            's5':21,'x21':21,'s6':22,'x22':22,'s7':23,'x23':23,
            's8':24,'x24':24,'s9':25,'x25':25,'s10':26,'x26':26,
            's11':27,'x27':27,'t3':28,'x28':28,'t4':29,'x29':29,
            't5':30,'x30':30,'t6':31,'x31':31
        };

        // Opcodes
        this.OP_R      = 0b0110011;
        this.OP_I_ALU  = 0b0010011;
        this.OP_LOAD   = 0b0000011;
        this.OP_STORE  = 0b0100011;
        this.OP_BRANCH = 0b1100011;
        this.OP_JAL    = 0b1101111;
        this.OP_JALR   = 0b1100111;
        this.OP_LUI    = 0b0110111;
        this.OP_AUIPC  = 0b0010111;
        this.OP_SYSTEM = 0b1110011;
    }

    // ─── Public entry point ────────────────────────────────────
    assemble(sourceText) {
        const result = { success: false, errors: [], instructions: [], dataSegment: [], symbols: {} };
        try {
            const lines     = this._cleanLines(sourceText);
            const symbols   = this._pass1(lines);
            result.symbols  = symbols;
            const { instructions, dataSegment, errors } = this._pass2(lines, symbols);
            result.instructions = instructions;
            result.dataSegment  = dataSegment;
            result.errors       = errors;
            result.success      = errors.length === 0;
        } catch (e) {
            result.errors.push('Fatal: ' + e.message);
        }
        return result;
    }

    // ─── Line preprocessing ────────────────────────────────────
    _cleanLines(src) {
        return src.split('\n').map((raw, i) => {
            const noComment = raw.replace(/[#;].*$/, '');
            return { raw: noComment.trim(), lineNum: i + 1 };
        });
    }

    // ─── Pass 1: build symbol table ───────────────────────────
    _pass1(lines) {
        const symbols = {};
        let textAddr = 0x0000;
        let dataAddr = 0x4000;
        let section  = 'text';

        for (const { raw } of lines) {
            let line = raw;
            if (!line) continue;

            if (line === '.text') { section = 'text'; continue; }
            if (line === '.data') { section = 'data'; continue; }

            // Consume label
            if (line.includes(':')) {
                const ci   = line.indexOf(':');
                const lbl  = line.substring(0, ci).trim();
                if (!/\s/.test(lbl) && lbl) {
                    symbols[lbl] = (section === 'text') ? textAddr : dataAddr;
                }
                line = line.substring(ci + 1).trim();
            }

            if (!line) continue;

            if (section === 'text') {
                textAddr += this._instrWords(line) * 4;
            } else {
                dataAddr += this._dataBytes(line);
            }
        }
        return symbols;
    }

    // ─── Pass 2: encode ───────────────────────────────────────
    _pass2(lines, symbols) {
        const instructions = [];
        const dataSegment  = [];
        const errors       = [];
        let textAddr = 0x0000;
        let dataAddr = 0x4000;
        let section  = 'text';

        for (const { raw, lineNum } of lines) {
            let line = raw;
            if (!line) continue;

            if (line === '.text') { section = 'text'; continue; }
            if (line === '.data') { section = 'data'; continue; }

            // Consume label
            if (line.includes(':')) {
                line = line.substring(line.indexOf(':') + 1).trim();
            }
            if (!line) continue;

            if (section === 'text') {
                try {
                    const words = this._encodeInstruction(line, textAddr, symbols);
                    for (const w of words) {
                        instructions.push({ addr: textAddr, word: w, source: raw, lineNum });
                        textAddr += 4;
                    }
                } catch (e) {
                    errors.push(`Line ${lineNum}: ${e.message}`);
                    textAddr += 4;
                }
            } else {
                try {
                    const bytes = this._encodeData(line);
                    if (bytes.length) {
                        dataSegment.push({ addr: dataAddr, bytes });
                        dataAddr += bytes.length;
                    }
                } catch (e) {
                    errors.push(`Line ${lineNum}: ${e.message}`);
                }
            }
        }

        return { instructions, dataSegment, errors };
    }

    // ─── Instruction word count (for pass 1) ──────────────────
    _instrWords(line) {
        const mn = line.split(/[\s,]+/)[0].toLowerCase();
        const DOUBLE = ['li','la','call'];
        return DOUBLE.includes(mn) ? 2 : 1;
    }

    // ─── Data byte count (for pass 1) ─────────────────────────
    _dataBytes(line) {
        const parts = line.trim().split(/\s+/);
        const dir   = parts[0].toLowerCase();
        const rest  = line.substring(dir.length).trim();
        if (dir === '.word')  return rest.split(',').length * 4;
        if (dir === '.half')  return rest.split(',').length * 2;
        if (dir === '.byte')  return rest.split(',').length;
        if (dir === '.string' || dir === '.asciz') {
            const m = rest.match(/"((?:[^"\\]|\\.)*)"/);
            return m ? this._unescapeString(m[1]).length + 1 : 1;
        }
        if (dir === '.ascii') {
            const m = rest.match(/"((?:[^"\\]|\\.)*)"/);
            return m ? this._unescapeString(m[1]).length : 0;
        }
        return 0;
    }

    // ─── Encode one assembly line → array of 32-bit words ─────
    _encodeInstruction(line, pc, syms) {
        // Tokenise respecting offset(reg) syntax
        const tokens = this._tokenize(line);
        const mn     = tokens[0].toLowerCase();

        // ── Pseudo-instructions ──────────────────────────────
        switch (mn) {
            case 'nop':  return [this._encI(0, 0, 0, 0, this.OP_I_ALU)]; // addi x0,x0,0
            case 'ret':  return [this._encI(0, 1, 0, 0, this.OP_JALR)];  // jalr x0,ra,0
            case 'mv': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encI(0, rs, 0, rd, this.OP_I_ALU)];
            }
            case 'neg': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encR(0b0100000, rs, 0, 0, rd, this.OP_R)];
            }
            case 'not': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encI(-1, rs, 4, rd, this.OP_I_ALU)]; // xori rd,rs,-1
            }
            case 'seqz': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encI(1, rs, 3, rd, this.OP_I_ALU)]; // sltiu rd,rs,1
            }
            case 'snez': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encR(0, 0, rs, 3, rd, this.OP_R)]; // sltu rd,x0,rs
            }
            case 'sltz': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encR(0, 0, rs, 2, rd, this.OP_R)]; // slt rd,rs,x0
            }
            case 'sgtz': {
                const rd = this._reg(tokens[1]);
                const rs = this._reg(tokens[2]);
                return [this._encR(0, rs, 0, 2, rd, this.OP_R)]; // slt rd,x0,rs
            }
            case 'j': {
                const offset = this._resolveLabel(tokens[1], pc, syms);
                return [this._encJ(offset, 0, this.OP_JAL)];
            }
            case 'jr': {
                const rs = this._reg(tokens[1]);
                return [this._encI(0, rs, 0, 0, this.OP_JALR)];
            }
            case 'beqz': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, 0, rs, 0, this.OP_BRANCH)];
            }
            case 'bnez': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, 0, rs, 1, this.OP_BRANCH)];
            }
            case 'bltz': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, 0, rs, 4, this.OP_BRANCH)]; // blt rs,x0
            }
            case 'bgtz': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, rs, 0, 4, this.OP_BRANCH)]; // blt x0,rs
            }
            case 'bgez': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, 0, rs, 5, this.OP_BRANCH)]; // bge rs,x0
            }
            case 'blez': {
                const rs = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encB(off, rs, 0, 5, this.OP_BRANCH)]; // bge x0,rs
            }
            case 'ble': {
                // ble rs1, rs2, label → bge rs2, rs1, label
                const rs1 = this._reg(tokens[1]);
                const rs2 = this._reg(tokens[2]);
                const off = this._resolveLabel(tokens[3], pc, syms);
                return [this._encB(off, rs1, rs2, 5, this.OP_BRANCH)];
            }
            case 'bgt': {
                // bgt rs1, rs2, label → blt rs2, rs1, label
                const rs1 = this._reg(tokens[1]);
                const rs2 = this._reg(tokens[2]);
                const off = this._resolveLabel(tokens[3], pc, syms);
                return [this._encB(off, rs1, rs2, 4, this.OP_BRANCH)];
            }
            case 'bleu': {
                // bleu rs1, rs2, label → bgeu rs2, rs1, label
                const rs1 = this._reg(tokens[1]);
                const rs2 = this._reg(tokens[2]);
                const off = this._resolveLabel(tokens[3], pc, syms);
                return [this._encB(off, rs1, rs2, 7, this.OP_BRANCH)];
            }
            case 'bgtu': {
                // bgtu rs1, rs2, label → bltu rs2, rs1, label
                const rs1 = this._reg(tokens[1]);
                const rs2 = this._reg(tokens[2]);
                const off = this._resolveLabel(tokens[3], pc, syms);
                return [this._encB(off, rs1, rs2, 6, this.OP_BRANCH)];
            }
            case 'li': {
                const rd  = this._reg(tokens[1]);
                const imm = this._imm(tokens[2]);
                if (imm >= -2048 && imm <= 2047) {
                    return [this._encI(imm, 0, 0, rd, this.OP_I_ALU)];
                } else {
                    const upper = (imm + 0x800) >> 12;
                    const lower = imm - (upper << 12);
                    return [
                        this._encU(upper << 12, rd, this.OP_LUI),
                        this._encI(lower, rd, 0, rd, this.OP_I_ALU)
                    ];
                }
            }
            case 'la': {
                const rd     = this._reg(tokens[1]);
                const target = this._resolveLabelAbs(tokens[2], syms);
                const offset = target - pc;
                const upper  = (offset + 0x800) >> 12;
                const lower  = offset - (upper << 12);
                return [
                    this._encU(upper << 12, rd, this.OP_AUIPC),
                    this._encI(lower, rd, 0, rd, this.OP_JALR) // addi-like
                ];
            }
            case 'call': {
                const target = this._resolveLabelAbs(tokens[1], syms);
                const offset = target - pc;
                const upper  = (offset + 0x800) >> 12;
                const lower  = offset - (upper << 12);
                return [
                    this._encU(upper << 12, 1, this.OP_AUIPC),
                    this._encI(lower, 1, 0, 1, this.OP_JALR)
                ];
            }
        }

        // ── Real instructions ────────────────────────────────
        switch (mn) {
            // R-type
            case 'add':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 0, this._reg(tokens[1]), this.OP_R)];
            case 'sub':  return [this._encR(0b0100000,  this._reg(tokens[3]), this._reg(tokens[2]), 0, this._reg(tokens[1]), this.OP_R)];
            case 'sll':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 1, this._reg(tokens[1]), this.OP_R)];
            case 'slt':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 2, this._reg(tokens[1]), this.OP_R)];
            case 'sltu': return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 3, this._reg(tokens[1]), this.OP_R)];
            case 'xor':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 4, this._reg(tokens[1]), this.OP_R)];
            case 'srl':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 5, this._reg(tokens[1]), this.OP_R)];
            case 'sra':  return [this._encR(0b0100000,  this._reg(tokens[3]), this._reg(tokens[2]), 5, this._reg(tokens[1]), this.OP_R)];
            case 'or':   return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 6, this._reg(tokens[1]), this.OP_R)];
            case 'and':  return [this._encR(0,          this._reg(tokens[3]), this._reg(tokens[2]), 7, this._reg(tokens[1]), this.OP_R)];

            // I-type ALU
            case 'addi':  return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 0, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'slti':  return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 2, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'sltiu': return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 3, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'xori':  return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 4, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'ori':   return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 6, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'andi':  return [this._encI(this._imm(tokens[3]), this._reg(tokens[2]), 7, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'slli':  return [this._encI((this._imm(tokens[3]) & 0x1F), this._reg(tokens[2]), 1, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'srli':  return [this._encI((this._imm(tokens[3]) & 0x1F), this._reg(tokens[2]), 5, this._reg(tokens[1]), this.OP_I_ALU)];
            case 'srai':  return [this._encI((this._imm(tokens[3]) & 0x1F) | (0b0100000 << 5), this._reg(tokens[2]), 5, this._reg(tokens[1]), this.OP_I_ALU)];

            // LUI / AUIPC
            case 'lui':   return [this._encU(this._imm(tokens[2]) << 12, this._reg(tokens[1]), this.OP_LUI)];
            case 'auipc': return [this._encU(this._imm(tokens[2]) << 12, this._reg(tokens[1]), this.OP_AUIPC)];

            // Load
            case 'lb':  { const [rs, off] = this._memOp(tokens[2]); return [this._encI(off, rs, 0, this._reg(tokens[1]), this.OP_LOAD)]; }
            case 'lh':  { const [rs, off] = this._memOp(tokens[2]); return [this._encI(off, rs, 1, this._reg(tokens[1]), this.OP_LOAD)]; }
            case 'lw':  { const [rs, off] = this._memOp(tokens[2]); return [this._encI(off, rs, 2, this._reg(tokens[1]), this.OP_LOAD)]; }
            case 'lbu': { const [rs, off] = this._memOp(tokens[2]); return [this._encI(off, rs, 4, this._reg(tokens[1]), this.OP_LOAD)]; }
            case 'lhu': { const [rs, off] = this._memOp(tokens[2]); return [this._encI(off, rs, 5, this._reg(tokens[1]), this.OP_LOAD)]; }

            // Store
            case 'sb': { const [rb, of2] = this._memOp(tokens[2]); return [this._encS(of2, this._reg(tokens[1]), rb, 0, this.OP_STORE)]; }
            case 'sh': { const [rb, of2] = this._memOp(tokens[2]); return [this._encS(of2, this._reg(tokens[1]), rb, 1, this.OP_STORE)]; }
            case 'sw': { const [rb, of2] = this._memOp(tokens[2]); return [this._encS(of2, this._reg(tokens[1]), rb, 2, this.OP_STORE)]; }

            // Branch
            case 'beq':  return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 0, this.OP_BRANCH)];
            case 'bne':  return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 1, this.OP_BRANCH)];
            case 'blt':  return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 4, this.OP_BRANCH)];
            case 'bge':  return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 5, this.OP_BRANCH)];
            case 'bltu': return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 6, this.OP_BRANCH)];
            case 'bgeu': return [this._encB(this._resolveLabel(tokens[3], pc, syms), this._reg(tokens[2]), this._reg(tokens[1]), 7, this.OP_BRANCH)];

            // Jumps
            case 'jal': {
                const rd  = this._reg(tokens[1]);
                const off = this._resolveLabel(tokens[2], pc, syms);
                return [this._encJ(off, rd, this.OP_JAL)];
            }
            case 'jalr': {
                const rd  = this._reg(tokens[1]);
                const rs1 = this._reg(tokens[2]);
                const imm = tokens[3] ? this._imm(tokens[3]) : 0;
                return [this._encI(imm, rs1, 0, rd, this.OP_JALR)];
            }

            // System
            case 'ecall':  return [this._encI(0, 0, 0, 0, this.OP_SYSTEM)];
            case 'ebreak': return [this._encI(1, 0, 0, 0, this.OP_SYSTEM)];

            default:
                throw new Error(`Unknown mnemonic: "${mn}"`);
        }
    }

    // ─── Encode data directives → bytes ────────────────────────
    _encodeData(line) {
        const parts = line.trim().split(/\s+/);
        const dir   = parts[0].toLowerCase();
        const rest  = line.substring(dir.length).trim();
        const bytes = [];

        if (dir === '.word') {
            for (const v of rest.split(',')) {
                const n = parseInt(v.trim(), this._baseOf(v.trim()));
                bytes.push(n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF);
            }
        } else if (dir === '.half') {
            for (const v of rest.split(',')) {
                const n = parseInt(v.trim(), this._baseOf(v.trim()));
                bytes.push(n & 0xFF, (n >> 8) & 0xFF);
            }
        } else if (dir === '.byte') {
            for (const v of rest.split(',')) {
                bytes.push(parseInt(v.trim(), this._baseOf(v.trim())) & 0xFF);
            }
        } else if (dir === '.string' || dir === '.asciz') {
            const m = rest.match(/"((?:[^"\\]|\\.)*)"/);
            if (m) {
                for (const c of this._unescapeString(m[1])) bytes.push(c.charCodeAt(0));
                bytes.push(0); // null terminator
            }
        } else if (dir === '.ascii') {
            const m = rest.match(/"((?:[^"\\]|\\.)*)"/);
            if (m) for (const c of this._unescapeString(m[1])) bytes.push(c.charCodeAt(0));
        }

        return bytes;
    }

    // ─── Bit encoders ──────────────────────────────────────────
    _encR(f7, rs2, rs1, f3, rd, op) {
        return (((f7 & 0x7F) << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
                ((f3 & 7) << 12) | ((rd & 0x1F) << 7) | (op & 0x7F)) >>> 0;
    }

    _encI(imm, rs1, f3, rd, op) {
        const i12 = imm & 0xFFF;
        return (((i12 << 20) | ((rs1 & 0x1F) << 15) | ((f3 & 7) << 12) | ((rd & 0x1F) << 7) | (op & 0x7F)) >>> 0);
    }

    _encS(imm, rs2, rs1, f3, op) {
        const i12     = imm & 0xFFF;
        const imm11_5 = (i12 >> 5) & 0x7F;
        const imm4_0  = i12 & 0x1F;
        return (((imm11_5 << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
                 ((f3 & 7) << 12) | (imm4_0 << 7) | (op & 0x7F)) >>> 0);
    }

    _encB(imm, rs2, rs1, f3, op) {
        const i    = imm & 0x1FFF;
        const b12  = (i >> 12) & 1;
        const b11  = (i >> 11) & 1;
        const b10_5 = (i >> 5) & 0x3F;
        const b4_1  = (i >> 1) & 0xF;
        return (((b12 << 31) | (b10_5 << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
                 ((f3 & 7) << 12) | (b4_1 << 8) | (b11 << 7) | (op & 0x7F)) >>> 0);
    }

    _encU(imm, rd, op) {
        return ((imm & 0xFFFFF000) | ((rd & 0x1F) << 7) | (op & 0x7F)) >>> 0;
    }

    _encJ(imm, rd, op) {
        const i    = imm & 0x1FFFFF;
        const b20  = (i >> 20) & 1;
        const b10_1 = (i >> 1) & 0x3FF;
        const b11  = (i >> 11) & 1;
        const b19_12 = (i >> 12) & 0xFF;
        return (((b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) |
                 ((rd & 0x1F) << 7) | (op & 0x7F)) >>> 0);
    }

    // ─── Helpers ──────────────────────────────────────────────
    _reg(name) {
        if (name === undefined) throw new Error('Missing register operand');
        const n = name.toLowerCase().trim();
        if (n in this.REGS) return this.REGS[n];
        throw new Error(`Unknown register: "${name}"`);
    }

    _imm(str) {
        if (str === undefined) throw new Error('Missing immediate operand');
        str = str.trim();
        if (str.startsWith('0x') || str.startsWith('0X')) return parseInt(str, 16);
        if (str.startsWith('0b') || str.startsWith('0B')) return parseInt(str.slice(2), 2);
        const n = parseInt(str, 10);
        if (isNaN(n)) throw new Error(`Invalid immediate: "${str}"`);
        return n;
    }

    _baseOf(str) {
        if (str.startsWith('0x') || str.startsWith('0X')) return 16;
        if (str.startsWith('0b') || str.startsWith('0B')) return 2;
        return 10;
    }

    // Parse offset(register) syntax
    _memOp(str) {
        const m = str.match(/^(-?\d+|0x[0-9a-fA-F]+)?\((\w+)\)$/);
        if (!m) throw new Error(`Invalid memory operand: "${str}"`);
        const offset = m[1] ? this._imm(m[1]) : 0;
        const reg    = this._reg(m[2]);
        return [reg, offset];
    }

    // Resolve label → relative byte offset from pc
    _resolveLabel(token, pc, syms) {
        if (token in syms) return syms[token] - pc;
        try { return this._imm(token); } catch (_) { throw new Error(`Undefined label: "${token}"`); }
    }

    // Resolve label → absolute address
    _resolveLabelAbs(token, syms) {
        if (token in syms) return syms[token];
        try { return this._imm(token); } catch (_) { throw new Error(`Undefined symbol: "${token}"`); }
    }

    _unescapeString(s) {
        return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
                .replace(/\\0/g, '\0').replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }

    // Tokenise a line — handles offset(reg) as one token
    _tokenize(line) {
        const tokens = [];
        let buf = '';
        let inParen = false;
        for (const ch of line + ' ') {
            if (ch === '(') { inParen = true; buf += ch; }
            else if (ch === ')') { inParen = false; buf += ch; }
            else if ((ch === ' ' || ch === '\t' || ch === ',') && !inParen) {
                if (buf) { tokens.push(buf); buf = ''; }
            } else {
                buf += ch;
            }
        }
        return tokens;
    }

    // ─── Decode a machine word back to human-readable ──────────
    decode(word, pc) {
        const op     = word & 0x7F;
        const rd     = (word >> 7) & 0x1F;
        const f3     = (word >> 12) & 0x7;
        const rs1    = (word >> 15) & 0x1F;
        const rs2    = (word >> 20) & 0x1F;
        const f7     = (word >> 25) & 0x7F;
        const RNAME  = Object.entries(this.REGS).filter(([k]) => k.startsWith('x') || k === 'zero' || k === 'ra' || k === 'sp').reduce((a,[k,v])=>(a[v]=a[v]||k,a),{});
        const rn     = i => `x${i}`;

        const iImm = (word >> 20) & 0xFFF;
        const iImmS = iImm >= 0x800 ? iImm - 0x1000 : iImm;

        const sImm11_5 = (word >> 25) & 0x7F;
        const sImm4_0  = (word >> 7) & 0x1F;
        const sImm     = ((sImm11_5 << 5) | sImm4_0);
        const sImmS    = sImm >= 0x800 ? sImm - 0x1000 : sImm;

        const bImm12 = (word >> 31) & 1;
        const bImm11 = (word >> 7) & 1;
        const bImm10_5 = (word >> 25) & 0x3F;
        const bImm4_1  = (word >> 8) & 0xF;
        const bOff = (bImm12 << 12) | (bImm11 << 11) | (bImm10_5 << 5) | (bImm4_1 << 1);
        const bOffS = bOff >= 0x1000 ? bOff - 0x2000 : bOff;

        const uImm = word & 0xFFFFF000;

        const jImm20 = (word >> 31) & 1;
        const jImm10_1 = (word >> 21) & 0x3FF;
        const jImm11 = (word >> 20) & 1;
        const jImm19_12 = (word >> 12) & 0xFF;
        const jOff = (jImm20 << 20) | (jImm19_12 << 12) | (jImm11 << 11) | (jImm10_1 << 1);
        const jOffS = jOff >= 0x100000 ? jOff - 0x200000 : jOff;

        const fmt = {
            opcode: '0b' + op.toString(2).padStart(7,'0'),
            rd: rn(rd), rs1: rn(rs1), rs2: rn(rs2),
            funct3: '0b' + f3.toString(2).padStart(3,'0'),
            funct7: '0b' + f7.toString(2).padStart(7,'0'),
        };

        let asm = `0x${word.toString(16).padStart(8,'0')}`;

        switch (op) {
            case this.OP_R: {
                const names = {
                    '0_0':'add','32_0':'sub','0_1':'sll','0_2':'slt','0_3':'sltu',
                    '0_4':'xor','0_5':'srl','32_5':'sra','0_6':'or','0_7':'and'
                };
                const mn2 = names[`${f7}_${f3}`] || 'R?';
                asm = `${mn2} ${rn(rd)}, ${rn(rs1)}, ${rn(rs2)}`;
                fmt.type = 'R'; break;
            }
            case this.OP_I_ALU: {
                const names2 = {0:'addi',2:'slti',3:'sltiu',4:'xori',6:'ori',7:'andi'};
                if (f3 === 1)      asm = `slli ${rn(rd)}, ${rn(rs1)}, ${iImmS & 0x1F}`;
                else if (f3 === 5) asm = `${f7 ? 'srai' : 'srli'} ${rn(rd)}, ${rn(rs1)}, ${iImmS & 0x1F}`;
                else               asm = `${names2[f3] || 'I?'} ${rn(rd)}, ${rn(rs1)}, ${iImmS}`;
                fmt.imm = iImmS; fmt.type = 'I'; break;
            }
            case this.OP_LOAD: {
                const ld = {0:'lb',1:'lh',2:'lw',4:'lbu',5:'lhu'};
                asm = `${ld[f3]||'ld?'} ${rn(rd)}, ${iImmS}(${rn(rs1)})`;
                fmt.imm = iImmS; fmt.type = 'I(Load)'; break;
            }
            case this.OP_STORE: {
                const st = {0:'sb',1:'sh',2:'sw'};
                asm = `${st[f3]||'st?'} ${rn(rs2)}, ${sImmS}(${rn(rs1)})`;
                fmt.imm = sImmS; fmt.type = 'S'; break;
            }
            case this.OP_BRANCH: {
                const br = {0:'beq',1:'bne',4:'blt',5:'bge',6:'bltu',7:'bgeu'};
                asm = `${br[f3]||'br?'} ${rn(rs1)}, ${rn(rs2)}, ${pc+bOffS} (offset: ${bOffS})`;
                fmt.imm = bOffS; fmt.type = 'B'; break;
            }
            case this.OP_JAL:
                asm = `jal ${rn(rd)}, ${pc+jOffS} (offset: ${jOffS})`;
                fmt.imm = jOffS; fmt.type = 'J'; break;
            case this.OP_JALR:
                asm = `jalr ${rn(rd)}, ${rn(rs1)}, ${iImmS}`;
                fmt.imm = iImmS; fmt.type = 'I(JALR)'; break;
            case this.OP_LUI:
                asm = `lui ${rn(rd)}, 0x${(uImm >>> 12).toString(16)}`;
                fmt.imm = uImm; fmt.type = 'U'; break;
            case this.OP_AUIPC:
                asm = `auipc ${rn(rd)}, 0x${(uImm >>> 12).toString(16)}`;
                fmt.imm = uImm; fmt.type = 'U'; break;
            case this.OP_SYSTEM:
                asm = iImmS === 0 ? 'ecall' : 'ebreak';
                fmt.type = 'SYSTEM'; break;
            default:
                asm = `??? (opcode=0b${op.toString(2).padStart(7,'0')})`;
                fmt.type = 'UNKNOWN';
        }

        return { asm, ...fmt };
    }
}
