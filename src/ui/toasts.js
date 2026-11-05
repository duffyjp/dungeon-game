// Toasts: bottom-centre stack, max 3, 2.5 s each (spec §10).

export class Toasts {
  constructor(root) {
    this.root = root;
    this.stack = document.createElement('div');
    this.stack.className = 'toasts';
    root.appendChild(this.stack);
    this.items = [];
  }

  show(text, color = '#e6e8ea', ms = 2500) {
    const n = document.createElement('div');
    n.className = 'toast';
    n.style.color = color;
    n.textContent = text;
    this.stack.appendChild(n);
    this.items.push(n);
    while (this.items.length > 3) {
      const old = this.items.shift();
      old.remove();
    }
    setTimeout(() => {
      n.classList.add('out');
      setTimeout(() => {
        n.remove();
        const i = this.items.indexOf(n);
        if (i >= 0) this.items.splice(i, 1);
      }, 350);
    }, ms);
  }

  clear() { this.stack.innerHTML = ''; this.items.length = 0; }
}
