// ============================================================
//  UI Controller — wires core + assembler + editor together
// ============================================================

class SimulatorUI {
    constructor() {
        this.assembler   = new RISCVAssembler();
        this.core        = new RISCVCore();
        this.editor      = null;
        this.runTimer    = null;
        this.speedHz     = 4;      // steps per second
        this.prevRegs    = new Int32Array(32);
        this.addrToLine  = new Map(); // PC address → editor line number
        this.outputLines = [];
        this.maxOutput   = 500;
        this.assembled   = false;   // true after at least one successful assemble

        // Wire core callbacks
        this.core.onOutput = (msg, type) => this._appendOutput(msg, type);
        this.core.onHalt   = (code) => {
            this._appendOutput(`\n[Program exited with code ${code}]`, 'system');
            this._setRunState(false);
            this._updateStatus('Halted', 'halted');
        };
        this.core.onBreak  = (pc) => {
            this._appendOutput(`[EBREAK at 0x${pc.toString(16).padStart(8,'0')}]`, 'warn');
            this._setRunState(false);
            this._updateStatus('Break', 'halted');
        };
    }

    // ─── Initialise after DOM ready ───────────────────────────
    init() {
        this.editor = createEditor('asm-editor');
        this._bindControls();
        this._buildRegisterPanel();
        this._renderMemory(0x0000);
        this._updateStatus('Ready', 'ready');
        this._appendOutput('RISC-V RV32I Simulator ready.\nLoad an example or write your own assembly, then click Assemble & Run.\n', 'system');

        // Load default example and auto-assemble so memory is ready
        this.editor.setValue(EXAMPLES['fibonacci']);
        this._updateExampleSelect();
        // Defer so CodeMirror finishes rendering first
        setTimeout(() => this.assemble(), 150);
    }

    // ─── Control binding ──────────────────────────────────────
    _bindControls() {
        document.getElementById('btn-assemble').addEventListener('click', () => this.assemble());
        document.getElementById('btn-run').addEventListener('click',      () => this.toggleRun());
        document.getElementById('btn-step').addEventListener('click',     () => this.step());
        document.getElementById('btn-reset').addEventListener('click',    () => this.resetSim());
        document.getElementById('btn-clear-console').addEventListener('click', () => this.clearConsole());
        document.getElementById('speed-slider').addEventListener('input', e => {
            this.speedHz = parseFloat(e.target.value);
            document.getElementById('speed-label').textContent = this.speedHz >= 1000
                ? `${(this.speedHz/1000).toFixed(1)}kHz`
                : `${this.speedHz}Hz`;
            if (this.runTimer) { this._stopRun(); this._startRun(); }
        });
        document.getElementById('mem-addr-input').addEventListener('change', e => {
            const addr = parseInt(e.target.value, 16) || 0;
            this._renderMemory(addr & ~0xF);
        });
        document.getElementById('example-select').addEventListener('change', e => {
            if (e.target.value && EXAMPLES[e.target.value]) {
                this.editor.setValue(EXAMPLES[e.target.value]);
            }
        });
        document.getElementById('btn-mem-prev').addEventListener('click', () => {
            const cur = parseInt(document.getElementById('mem-addr-input').value || '0', 16);
            this._renderMemory(Math.max(0, (cur - 0x80)) & ~0xF);
        });
        document.getElementById('btn-mem-next').addEventListener('click', () => {
            const cur = parseInt(document.getElementById('mem-addr-input').value || '0', 16);
            this._renderMemory((cur + 0x80) & ~0xF);
        });
    }

    // ─── Assemble ─────────────────────────────────────────────
    assemble() {
        this.assembled = false;
        const src    = this.editor.getValue();
        const result = this.assembler.assemble(src);

        document.getElementById('error-panel').innerHTML = '';
        if (!result.success || result.errors.length > 0) {
            const ep = document.getElementById('error-panel');
            ep.innerHTML = result.errors.map(e =>
                `<div class="error-line"><span class="err-icon">⚠</span> ${this._esc(e)}</div>`
            ).join('');
            this._updateStatus('Assembly Error', 'error');
            this._appendOutput('[Assembly failed] ' + result.errors.join('; '), 'error');
            return false;
        }

        // Build PC → line mapping
        this.addrToLine.clear();
        for (const { addr, lineNum } of result.instructions) {
            this.addrToLine.set(addr, lineNum - 1); // 0-indexed
        }

        this.core.loadProgram(result.instructions, result.dataSegment);
        this.prevRegs = this.core.getRegisters();

        this._updateAllRegisters(null);
        this._renderMemory(0x0000);
        this._updateDecoder(null);
        this._updateStatus('Assembled', 'ready');
        clearHighlight(this.editor);

        const instrCount = result.instructions.length;
        const dataBytes  = result.dataSegment.reduce((s, d) => s + d.bytes.length, 0);
        this._appendOutput(
            `[Assembled OK] ${instrCount} instructions (${instrCount*4} bytes), ${dataBytes} data bytes, ${Object.keys(result.symbols).length} labels\n`,
            'system'
        );

        // Show symbols
        const syms = Object.entries(result.symbols).map(([k,v]) => `${k}=0x${v.toString(16)}`).join(', ');
        if (syms) this._appendOutput(`[Symbols] ${syms}\n`, 'system');

        this.assembled = true;
        return true;
    }

    // ─── Step one instruction ─────────────────────────────────
    step() {
        // Auto-assemble if nothing has been loaded yet
        if (!this.assembled) {
            if (!this.assemble()) return;
        }
        if (this.core.isHalted()) {
            this._appendOutput('[Halted — press Reset to restart]', 'warn');
            return;
        }

        const prevRegs = this.core.getRegisters();
        const result   = this.core.step(this.assembler);

        this._updateAllRegisters(this.core.lastChangedRegs);
        this._updateDecoder(this.core.lastInstrInfo);
        this._updatePC();
        this._renderMemory(this._currentMemBase());

        if (this.core.lastMemWrite !== null) {
            this._flashMemory(this.core.lastMemWrite);
        }

        if (result.halted) {
            this._setRunState(false);
        }
        document.getElementById('cycle-count').textContent = `Cycles: ${this.core.getCycleCount()}`;
    }

    // ─── Toggle run/pause ─────────────────────────────────────
    toggleRun() {
        if (this.runTimer) this._stopRun();
        else               this._startRun();
    }

    _startRun() {
        // Auto-assemble if not yet loaded, or re-assemble after halt
        if (!this.assembled || this.core.isHalted()) {
            if (!this.assemble()) return; // stop if assembly failed
        }
        this._setRunState(true);
        const interval = Math.max(1, Math.round(1000 / this.speedHz));
        // For very high speeds, run multiple steps per tick
        const stepsPerTick = this.speedHz > 100 ? Math.ceil(this.speedHz / 100) : 1;
        const tickHz       = this.speedHz > 100 ? 100 : this.speedHz;

        this.runTimer = setInterval(() => {
            for (let i = 0; i < stepsPerTick; i++) {
                if (this.core.isHalted()) { this._stopRun(); return; }
                const result = this.core.step(this.assembler);
                if (result.halted) { this._stopRun(); break; }
            }
            // Update UI less frequently during fast run
            this._updateAllRegisters(this.core.lastChangedRegs);
            this._updateDecoder(this.core.lastInstrInfo);
            this._updatePC();
            document.getElementById('cycle-count').textContent = `Cycles: ${this.core.getCycleCount()}`;
        }, Math.round(1000 / tickHz));
    }

    _stopRun() {
        if (this.runTimer) { clearInterval(this.runTimer); this.runTimer = null; }
        this._setRunState(false);
        this._renderMemory(this._currentMemBase());
    }

    _setRunState(running) {
        const btn = document.getElementById('btn-run');
        if (running) {
            btn.textContent = '⏸ Pause';
            btn.classList.add('btn-pause');
            this._updateStatus('Running', 'running');
        } else {
            btn.textContent = '▶ Run';
            btn.classList.remove('btn-pause');
            if (!this.core.isHalted()) this._updateStatus('Paused', 'ready');
        }
    }

    // ─── Reset simulation ─────────────────────────────────────
    resetSim() {
        this._stopRun();
        this.assembled = false;
        this.core.reset();
        // Re-assemble and reload program
        this.assemble();
        clearHighlight(this.editor);
        this._updateStatus('Reset', 'ready');
        document.getElementById('cycle-count').textContent = 'Cycles: 0';
    }

    // ─── Register panel ───────────────────────────────────────
    _buildRegisterPanel() {
        const grid = document.getElementById('reg-grid');
        grid.innerHTML = '';
        for (let i = 0; i < 32; i++) {
            const cell = document.createElement('div');
            cell.className = 'reg-cell';
            cell.id        = `reg-${i}`;
            cell.innerHTML = `
                <span class="reg-name">x${i}<span class="reg-abi">${REG_ABI_NAMES[i]}</span></span>
                <span class="reg-val" id="reg-val-${i}">0x00000000</span>
                <span class="reg-dec" id="reg-dec-${i}">0</span>`;
            grid.appendChild(cell);
        }
    }

    _updateAllRegisters(changedSet) {
        const regs = this.core.getRegisters();
        for (let i = 0; i < 32; i++) {
            const valEl = document.getElementById(`reg-val-${i}`);
            const decEl = document.getElementById(`reg-dec-${i}`);
            const cell  = document.getElementById(`reg-${i}`);
            if (!valEl) continue;
            const unsigned = regs[i] >>> 0;
            valEl.textContent = '0x' + unsigned.toString(16).padStart(8, '0');
            decEl.textContent = regs[i].toString();
            if (changedSet && changedSet.has(i)) {
                cell.classList.remove('reg-changed');
                void cell.offsetWidth; // reflow
                cell.classList.add('reg-changed');
            }
        }
    }

    // ─── PC indicator ─────────────────────────────────────────
    _updatePC() {
        const pc  = this.core.getPC();
        document.getElementById('pc-display').textContent = '0x' + pc.toString(16).padStart(8, '0');
        const lineNum = this.addrToLine.get(pc);
        if (lineNum !== undefined) highlightLine(this.editor, lineNum);
    }

    // ─── Instruction decoder panel ────────────────────────────
    _updateDecoder(info) {
        const panel = document.getElementById('decoder-panel');
        if (!info) {
            panel.innerHTML = '<span class="decoder-idle">No instruction fetched yet</span>';
            return;
        }
        panel.innerHTML = `
            <div class="dec-row"><span class="dec-label">Assembly</span><span class="dec-val dec-asm">${this._esc(info.asm)}</span></div>
            <div class="dec-row"><span class="dec-label">Type</span><span class="dec-val dec-type">${info.type || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">Opcode</span><span class="dec-val dec-bits">${info.opcode || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">rd</span><span class="dec-val">${info.rd || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">rs1</span><span class="dec-val">${info.rs1 || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">rs2</span><span class="dec-val">${info.rs2 || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">funct3</span><span class="dec-val dec-bits">${info.funct3 || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">funct7</span><span class="dec-val dec-bits">${info.funct7 || '—'}</span></div>
            <div class="dec-row"><span class="dec-label">PC</span><span class="dec-val">0x${this.core.lastInstrPC.toString(16).padStart(8,'0')}</span></div>
            <div class="dec-row"><span class="dec-label">Encoding</span><span class="dec-val dec-bits">0x${(this.core.lastInstrWord>>>0).toString(16).padStart(8,'0')}</span></div>
        `;
    }

    // ─── Memory viewer ────────────────────────────────────────
    _currentMemBase() {
        return parseInt(document.getElementById('mem-addr-input').value || '0', 16) & ~0xF;
    }

    _renderMemory(baseAddr) {
        baseAddr = Math.max(0, baseAddr & ~0xF);
        document.getElementById('mem-addr-input').value = baseAddr.toString(16).padStart(4, '0');
        const tbody = document.getElementById('mem-tbody');
        tbody.innerHTML = '';
        const pc = this.core.getPC();
        const sp = (this.core.getRegisters()[2]) >>> 0;

        for (let row = 0; row < 16; row++) {
            const addr = baseAddr + row * 16;
            if (addr >= this.core.MEM_SIZE) break;
            const slice = this.core.getMemorySlice(addr, 16);
            const tr    = document.createElement('tr');

            // Address cell
            const addrTd = document.createElement('td');
            addrTd.className = 'mem-addr';
            addrTd.textContent = '0x' + addr.toString(16).padStart(4, '0');
            if (addr <= pc && pc < addr + 16) addrTd.classList.add('mem-pc-row');
            if (addr <= sp && sp < addr + 16) addrTd.classList.add('mem-sp-row');
            tr.appendChild(addrTd);

            // Hex bytes
            const hex4Groups = [];
            for (let g = 0; g < 4; g++) {
                const groupTd = document.createElement('td');
                groupTd.className = 'mem-group';
                const bytes = [];
                for (let b = 0; b < 4; b++) {
                    const byteAddr = addr + g * 4 + b;
                    const val  = slice[g * 4 + b] || 0;
                    const span = document.createElement('span');
                    span.className = 'mem-byte';
                    span.textContent = val.toString(16).padStart(2, '0');
                    if (byteAddr === pc || byteAddr === pc+1 || byteAddr === pc+2 || byteAddr === pc+3) span.classList.add('mem-pc-byte');
                    if (this.core.lastMemWrite !== null) {
                        const lw = this.core.lastMemWrite >>> 0;
                        if (byteAddr >= lw && byteAddr < lw + 4) span.classList.add('mem-written');
                    }
                    bytes.push(span.outerHTML);
                }
                groupTd.innerHTML = bytes.join(' ');
                tr.appendChild(groupTd);
            }

            // ASCII representation
            const asciiTd = document.createElement('td');
            asciiTd.className = 'mem-ascii';
            let ascii = '';
            for (let b = 0; b < 16 && addr + b < this.core.MEM_SIZE; b++) {
                const c = slice[b] || 0;
                ascii += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
            }
            asciiTd.textContent = ascii;
            tr.appendChild(asciiTd);

            tbody.appendChild(tr);
        }
    }

    _flashMemory(addr) {
        // Re-render near the written address
        this._renderMemory(addr & ~0xF);
    }

    // ─── Console output ───────────────────────────────────────
    _appendOutput(msg, type = 'default') {
        const console = document.getElementById('output-console');
        const line = document.createElement('span');
        line.className = `out-${type}`;
        line.textContent = msg;
        console.appendChild(line);
        this.outputLines.push(line);
        if (this.outputLines.length > this.maxOutput) {
            this.outputLines.shift().remove();
        }
        console.scrollTop = console.scrollHeight;
    }

    clearConsole() {
        document.getElementById('output-console').innerHTML = '';
        this.outputLines = [];
    }

    // ─── Status bar ───────────────────────────────────────────
    _updateStatus(text, state) {
        const el = document.getElementById('status-text');
        el.textContent = text;
        el.className = 'status-' + state;
    }

    // ─── Example programs selector ────────────────────────────
    _updateExampleSelect() {
        const sel = document.getElementById('example-select');
        sel.innerHTML = '<option value="">Load Example...</option>';
        for (const key of Object.keys(EXAMPLES)) {
            const opt = document.createElement('option');
            opt.value       = key;
            opt.textContent = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            sel.appendChild(opt);
        }
    }

    _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
}

// ============================================================
//  Example Programs
// ============================================================
const EXAMPLES = {
fibonacci: `# Fibonacci Sequence (RV32I)
# Computes first 10 Fibonacci numbers and prints them
# Uses ecall a7=1 for printing integers

.text
main:
    li   a0, 0          # F(0) = 0
    li   a1, 1          # F(1) = 1
    li   t0, 10         # Counter = 10

fib_loop:
    beqz t0, done       # if counter == 0, exit loop

    # Print current Fibonacci number
    mv   a2, a0         # save a0
    li   a7, 1          # print_int syscall
    ecall               # print a0
    li   a7, 11         # print_char syscall
    li   a0, 10         # newline '\\n'
    ecall
    mv   a0, a2         # restore a0

    # Next Fibonacci
    add  t1, a0, a1     # t1 = a0 + a1
    mv   a0, a1         # a0 = a1
    mv   a1, t1         # a1 = t1
    addi t0, t0, -1     # counter--
    j    fib_loop

done:
    li   a7, 10         # exit syscall
    li   a0, 0
    ecall
`,

factorial: `# Factorial using recursion (RV32I)
# Computes 8! = 40320

.text
main:
    li   a0, 8          # n = 8
    call factorial      # call factorial(8)
    li   a7, 1          # print result
    ecall
    li   a7, 11
    li   a0, 10         # newline
    ecall
    li   a7, 10         # exit
    li   a0, 0
    ecall

# int factorial(int n) in a0
factorial:
    addi sp, sp, -8     # allocate stack frame
    sw   ra, 4(sp)      # save return address
    sw   a0, 0(sp)      # save n

    li   t0, 1
    bge  t0, a0, base   # if n <= 1, return 1

    addi a0, a0, -1     # a0 = n - 1
    call factorial       # recursive call
    mv   t1, a0          # t1 = factorial(n-1)
    lw   a0, 0(sp)       # restore n
    mul_loop:            # multiply n * t1 using shifts (no MUL in RV32I)
        # Simple multiply using repeated addition
        li   t2, 0           # result = 0
        mv   t3, a0          # t3 = n
    mul:
        beqz t3, mul_done
        add  t2, t2, t1
        addi t3, t3, -1
        j    mul
    mul_done:
        mv   a0, t2
    lw   ra, 4(sp)       # restore return address
    addi sp, sp, 8       # free stack frame
    ret

base:
    li   a0, 1           # return 1
    lw   ra, 4(sp)
    addi sp, sp, 8
    ret
`,

bubble_sort: `# Bubble Sort — sorts an array of 8 integers
.data
array:  .word 64, 23, 8, 1, 100, 42, 17, 55
size:   .word 8

.text
main:
    la   s0, array      # s0 = base address of array
    la   t0, size
    lw   s1, 0(t0)      # s1 = n (array size)

    li   s2, 0          # outer loop i = 0
outer:
    li   t1, 1
    sub  t2, s1, s2     # t2 = n - i
    bge  t1, t2, print  # if n-i <= 1, done

    li   s3, 0          # inner loop j = 0
    addi t3, t2, -1     # inner limit = n-i-1
inner:
    bge  s3, t3, outer_next

    # Load array[j] and array[j+1]
    slli t4, s3, 2      # t4 = j * 4
    add  t4, s0, t4     # t4 = &array[j]
    lw   a0, 0(t4)      # a0 = array[j]
    lw   a1, 4(t4)      # a1 = array[j+1]

    # Swap if array[j] > array[j+1]
    ble  a0, a1, no_swap
    sw   a1, 0(t4)
    sw   a0, 4(t4)
no_swap:
    addi s3, s3, 1
    j    inner

outer_next:
    addi s2, s2, 1
    j    outer

print:
    # Print sorted array
    li   s3, 0
print_loop:
    bge  s3, s1, done
    slli t0, s3, 2
    add  t0, s0, t0
    lw   a0, 0(t0)
    li   a7, 1
    ecall
    li   a7, 11
    li   a0, 32         # space
    ecall
    addi s3, s3, 1
    j    print_loop
done:
    li   a7, 10
    li   a0, 0
    ecall
`,

register_demo: `# Register & ALU demonstration
# Tests arithmetic, logic, shifts, comparisons

.text
main:
    # Arithmetic
    li   t0, 42
    li   t1, 13
    add  t2, t0, t1     # t2 = 55
    sub  t3, t0, t1     # t3 = 29

    # Print t2
    mv   a0, t2
    li   a7, 1
    ecall
    li   a7, 11
    li   a0, 10
    ecall

    # Logic operations
    li   t0, 0xFF
    li   t1, 0x0F
    and  t2, t0, t1     # t2 = 0x0F = 15
    or   t3, t0, t1     # t3 = 0xFF = 255
    xor  t4, t0, t1     # t4 = 0xF0 = 240

    mv   a0, t2
    li   a7, 1
    ecall
    li   a7, 11
    li   a0, 10
    ecall

    # Shifts
    li   t0, 1
    slli t1, t0, 7      # t1 = 128
    mv   a0, t1
    li   a7, 1
    ecall
    li   a7, 11
    li   a0, 10
    ecall

    # Comparison
    li   t0, 100
    li   t1, 200
    slt  t2, t0, t1     # t2 = 1 (100 < 200)
    mv   a0, t2
    li   a7, 1
    ecall

    li   a7, 10
    li   a0, 0
    ecall
`,

memory_demo: `# Memory Operations Demo — loads and stores
.data
buffer: .word 10, 20, 30, 40, 50
msg:    .asciz "Sum = "

.text
main:
    la   s0, buffer     # s0 = buffer base
    li   s1, 5          # count = 5
    li   s2, 0          # sum = 0
    li   s3, 0          # i = 0

loop:
    bge  s3, s1, show_result
    slli t0, s3, 2
    add  t0, s0, t0
    lw   t1, 0(t0)      # load buffer[i]
    add  s2, s2, t1     # sum += buffer[i]
    addi s3, s3, 1
    j    loop

show_result:
    # Print "Sum = "
    la   a0, msg
    li   a7, 4
    ecall

    # Print sum
    mv   a0, s2
    li   a7, 1
    ecall

    li   a7, 10
    li   a0, 0
    ecall
`,
};

// ─── Boot ─────────────────────────────────────────────────────
const ui = new SimulatorUI();
document.addEventListener('DOMContentLoaded', () => ui.init());
