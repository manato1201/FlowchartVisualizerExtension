export class Player {
  private isGrounded = false;
  private isFalling = false;
  private state = 0;
  private enemies: Array<{ dead: boolean }> = [];

  update(): void {
    if (this.isGrounded) {
      this.jump();
    } else if (this.isFalling) {
      this.applyGravity();
    }

    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].dead) {
        this.destroy(i);
      }
    }

    switch (this.state) {
      case 0:
        this.playIdle();
        break;
      default:
        this.playDefault();
        break;
    }
  }

  other(): void {
    while (this.isFalling) {
      this.applyGravity();
    }
  }

  private jump(): void {}
  private applyGravity(): void {}
  private destroy(i: number): void {}
  private playIdle(): void {}
  private playDefault(): void {}
}
