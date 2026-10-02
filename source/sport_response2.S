/* Only the call at 08003cae is redirected here. Thumb-1, Cortex-M0+.
 * Same fixed-point filter as 0800a6b4; double coefficient only for a
 * positive target delta in Sport with both braking indicators inactive.
 * No coefficient is written to RAM, no current or speed cap is raised.
 */
.syntax unified
.thumb
.section .text
.global sport_response2
.type sport_response2,%function
.thumb_func
sport_response2:
    push {r4, lr}
    mov r4, r1
    ldr r1, [r1, #4]
    subs r0, r0, r1
    ldr r1, [r4]
    cmp r0, #0
    ble original_filter
    ldr r2, ride_mode
    ldrb r2, [r2]
    cmp r2, #4
    bne original_filter
    ldr r2, brake_input
    ldrb r2, [r2]
    cmp r2, #60
    bhi original_filter
    ldr r2, brake_active
    ldrh r2, [r2]
    cmp r2, #0
    bne original_filter
    ldr r2, regen_active
    ldrb r2, [r2]
    cmp r2, #0
    bne original_filter
    lsls r1, r1, #1
original_filter:
    /* Indirect BL preserves the original signed32 multiplication. */
    ldr r3, multiply
    blx r3
    lsls r1, r1, #16
    lsrs r0, r0, #16
    orrs r0, r1
    ldr r1, [r4, #4]
    adds r0, r0, r1
    str r0, [r4, #4]
    pop {r4, pc}
.balign 4
ride_mode: .word 0x20001428
brake_input: .word 0x20000327
brake_active: .word 0x2000154c
regen_active: .word 0x20001575
multiply: .word 0x0800d477
.size sport_response2, .-sport_response2
