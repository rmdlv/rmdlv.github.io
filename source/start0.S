/* Separate drive-start threshold. Keep the shared brake/lock/button threshold.
 * Normal riding modes 2..4 honor register 7F below the original floor of 32.
 * Zero maps to -1 internal LSB so strict speed > threshold includes standstill.
 * Existing released-throttle arming logic remains in the original function.
 */
.syntax unified
.thumb
.section .text
.global drive_threshold, control_gate, target_gate, cruise_cancel_gate, client_with_build_id
.type drive_threshold,%function
.thumb_func
drive_threshold:
    push {r1,r2,r3,lr}
    ldr r1, ride_state
    ldrb r0,[r1]
    cmp r0,#2
    blo stock_threshold
    cmp r0,#4
    bhi stock_threshold
    ldr r2,start_register
    ldrb r0,[r2]
    cmp r0,#32
    bhs stock_threshold
    cmp r0,#0
    beq zero_threshold
    lsls r0,r0,#16
    ldr r3,convert_speed
    blx r3
    movs r1,#10
    ldr r3,divide_signed
    blx r3
    pop {r1,r2,r3,pc}
zero_threshold:
    mvns r0,r0
    pop {r1,r2,r3,pc}
stock_threshold:
    ldr r0,[r1,#44]
    pop {r1,r2,r3,pc}
.size drive_threshold,.-drive_threshold

.type control_gate,%function
.thumb_func
control_gate:
    push {r0,r1,r4,lr}
    mov r4,r0
    bl drive_threshold
    mov r3,r0
    ldr r2,[r4,#40]
    pop {r0,r1,r4,pc}
.size control_gate,.-control_gate

.type target_gate,%function
.thumb_func
target_gate:
    push {r0,r3,r4,lr}
    bl drive_threshold
    mov r2,r0
    ldr r1,[r7,#40]
    pop {r0,r3,r4,pc}
.size target_gate,.-target_gate

.type cruise_cancel_gate,%function
.thumb_func
cruise_cancel_gate:
    push {r0,r2,r3,lr}
    bl drive_threshold
    mov r1,r0
    pop {r0,r2,r3,pc}
.size cruise_cancel_gate,.-cruise_cancel_gate

/* Read-only build probe: CMD7E/indexA5, four-byte payload "ID?1".
 * All other packets tail-call the unmodified ClientHandleCommand.
 */
.type client_with_build_id,%function
.thumb_func
client_with_build_id:
    push {r4,lr}
    mov r4,r0
    ldrb r1,[r4,#3]
    cmp r1,#126
    bne original_client
    ldrb r1,[r4,#4]
    cmp r1,#165
    bne original_client
    ldrb r1,[r4]
    cmp r1,#4
    bne original_client
    ldrb r1,[r4,#5]
    cmp r1,#73
    bne original_client
    ldrb r1,[r4,#6]
    cmp r1,#68
    bne original_client
    ldrb r1,[r4,#7]
    cmp r1,#63
    bne original_client
    ldrb r1,[r4,#8]
    cmp r1,#49
    bne original_client
    sub sp,#16
    movs r0,#16
    str r0,[sp]
    movs r0,#126
    str r0,[sp,#4]
    movs r0,#165
    str r0,[sp,#8]
    adr r0,build_marker
    str r0,[sp,#12]
    ldrb r3,[r4,#1]
    movs r2,#32
    ldr r1,uart_callback
    movs r0,#0
    ldr r4,serialize
    blx r4
    add sp,#16
    pop {r4,pc}
original_client:
    mov r0,r4
    ldr r3,client_original
    blx r3
    pop {r4,pc}
.size client_with_build_id,.-client_with_build_id
.balign 4
ride_state: .word 0x20001428
start_register: .word 0x200008f0
convert_speed: .word 0x0800451d
divide_signed: .word 0x080012c7
uart_callback: .word 0x08002295
serialize: .word 0x08005435
client_original: .word 0x0800acbd
build_marker: .ascii "R2Z0.20261001.01"
